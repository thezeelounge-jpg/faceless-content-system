import { afterAll, describe, expect, it } from "vitest";
import { createConsentStore } from "@/lib/consent-store";
import { createAdminClient } from "@/lib/supabase/admin";

// OPT-IN: lib/consent-store.ts against the REAL staging Supabase (the memory
// store in tests/helpers can't prove the SQL filters, e.g. the SF2 claim and
// the SF4 "still this clip" save). Skipped unless RUN_STAGING_TESTS=1; never
// part of `npm test` (vitest.config.mts excludes tests/staging).
// How Rowan runs it (after `npm run db:push` to STAGING, never production):
//   RUN_STAGING_TESTS=1 STAGING_BRAND_ID=<id of a test brand on staging> npm run test:staging
// It creates one consent, one avatar and one mocked outbox row for that brand,
// and deletes them at the end. It reads keys from env and never prints them.

const RUN = process.env.RUN_STAGING_TESTS === "1";
const BRAND_ID = process.env.STAGING_BRAND_ID ?? "";

describe.skipIf(!RUN)("consent store on staging Supabase", () => {
  const created = { consents: [] as string[], avatars: [] as string[] };

  afterAll(async () => {
    if (!RUN) return;
    const db = createAdminClient();
    if (created.avatars.length) await db.from("avatars").delete().in("id", created.avatars);
    if (created.consents.length) {
      await db.from("email_outbox").delete().in("consent_id", created.consents);
      await db.from("consents").delete().in("id", created.consents);
    }
  });

  it("needs STAGING_BRAND_ID (a test brand on staging)", () => {
    expect(BRAND_ID).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("brand contact, consent insert/get/update, the SF4 'still this clip' save and the .mov swap", async () => {
    const store = createConsentStore();
    expect(await store.getBrandContact(BRAND_ID)).toMatchObject({ id: BRAND_ID });

    const consent = await store.insertConsent({
      brand_id: BRAND_ID,
      person_legal_name: "Staging Test Person",
      checkbox_at: new Date().toISOString(),
      words: ["apple", "river", "tiger"],
      words_expire_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      ip: null,
      user_agent: "staging-test",
    });
    created.consents.push(consent.id);
    expect(await store.getConsent(consent.id)).toMatchObject({ id: consent.id, admin_status: "pending" });

    const a = `${BRAND_ID}/${consent.id}/a.mov`;
    const b = `${BRAND_ID}/${consent.id}/b.mp4`;
    await store.updateConsent(consent.id, { clip_path: a, clip_check_status: "pending" }, true);
    const checks = { passed: true, clip_path: b, checked_at: new Date().toISOString(), checks: [], tips: [], measurements: {} as never };
    expect(await store.saveClipChecks(consent.id, b, checks)).toBeNull(); // not the current clip
    expect(await store.swapClipPath(consent.id, "wrong/path.mov", b)).toBeNull();
    expect((await store.swapClipPath(consent.id, a, b))?.clip_path).toBe(b);
    expect((await store.saveClipChecks(consent.id, b, checks))?.clip_checks?.clip_path).toBe(b);
  });

  it("one avatar per consent, and the SF2 claim wins only once", async () => {
    const store = createConsentStore();
    const consentId = created.consents[0];
    const first = await store.insertAvatar({ brand_id: BRAND_ID, consent_id: consentId, status: "training" });
    created.avatars.push(first.id);
    const again = await store.insertAvatar({ brand_id: BRAND_ID, consent_id: consentId, status: "training" });
    expect(again.id).toBe(first.id);
    const at = new Date().toISOString();
    expect(await store.claimTwinCreate(first.id, at)).not.toBeNull();
    expect(await store.claimTwinCreate(first.id, at)).toBeNull();
    expect((await store.updateAvatar(first.id, { error: "staging test" }))?.error).toBe("staging test");
  });

  it("mocked outbox rows are stored, never sent", async () => {
    const store = createConsentStore();
    const consentId = created.consents[0];
    await store.insertOutbox({
      brand_id: BRAND_ID,
      consent_id: consentId,
      to_email: "staging-test@example.invalid",
      kind: "consent_link",
      subject: "staging test",
      body: "staging test",
    });
    expect(await store.hasOutbox(consentId, "consent_link")).toBe(true);
  });
});
