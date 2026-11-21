import "server-only";
import type { ClipStorage, ConsentRow, ConsentStore, AvatarRow } from "@/lib/consent-store-types";
import { createAdminClient } from "@/lib/supabase/admin";

// Supabase versions of ConsentStore and ClipStorage. They use the SECRET key,
// so call them only after requireAdmin() (or inside a background task).
// Tests use tests/helpers/consent-memory.ts instead.

export const CONSENT_BUCKET = "consent-clips";

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`[consents] ${what}: ${error?.message ?? "no data"}`);
}

export function createConsentStore(): ConsentStore {
  const db = createAdminClient();
  return {
    async getBrandContact(brandId) {
      const { data: brand, error } = await db
        .from("brands")
        .select("id, name, owner_id, contact_email")
        .eq("id", brandId)
        .maybeSingle();
      if (error) fail("load brand", error);
      if (!brand) return null;
      const { data: owner } = await db.from("profiles").select("email").eq("id", brand.owner_id).maybeSingle();
      return { id: brand.id, name: brand.name, ownerEmail: owner?.email || null, contactEmail: brand.contact_email ?? null };
    },
    async setBrandContactEmail(brandId, email) {
      const { error } = await db.from("brands").update({ contact_email: email }).eq("id", brandId);
      if (error) fail("save client email", error);
    },
    async insertConsent(row) {
      const { data, error } = await db.from("consents").insert(row).select().single();
      if (error || !data) fail("insert consent", error);
      return data as ConsentRow;
    },
    async getConsent(id) {
      const { data, error } = await db.from("consents").select().eq("id", id).maybeSingle();
      if (error) fail("load consent", error);
      return (data as ConsentRow | null) ?? null;
    },
    async updateConsent(id, patch, onlyIfPending = false) {
      let query = db.from("consents").update(patch).eq("id", id);
      if (onlyIfPending) query = query.eq("admin_status", "pending");
      const { data, error } = await query.select().maybeSingle();
      if (error) fail("update consent", error);
      return (data as ConsentRow | null) ?? null;
    },
    async saveClipChecks(id, clipPath, checks) {
      const { data, error } = await db
        .from("consents")
        .update({ clip_checks: checks })
        .eq("id", id)
        .eq("clip_path", clipPath)
        .eq("admin_status", "pending")
        .select()
        .maybeSingle();
      if (error) fail("save clip checks", error);
      return (data as ConsentRow | null) ?? null;
    },
    async swapClipPath(id, from, to) {
      const { data, error } = await db
        .from("consents")
        .update({ clip_path: to, clip_checks: null })
        .eq("id", id)
        .eq("clip_path", from)
        .eq("admin_status", "pending")
        .select()
        .maybeSingle();
      if (error) fail("swap clip", error);
      return (data as ConsentRow | null) ?? null;
    },
    async listConsents() {
      const { data, error } = await db.from("consents").select().order("created_at", { ascending: false }).limit(200);
      if (error) fail("list consents", error);
      return (data ?? []) as ConsentRow[];
    },
    async getAvatarByConsent(consentId) {
      const { data, error } = await db.from("avatars").select().eq("consent_id", consentId).maybeSingle();
      if (error) fail("load avatar", error);
      return (data as AvatarRow | null) ?? null;
    },
    async getAvatar(id) {
      const { data, error } = await db.from("avatars").select().eq("id", id).maybeSingle();
      if (error) fail("load avatar", error);
      return (data as AvatarRow | null) ?? null;
    },
    async insertAvatar(row) {
      const { data, error } = await db.from("avatars").insert(row).select().single();
      if (!error && data) return data as AvatarRow;
      // 23505 = unique violation: this consent already has its one twin.
      if (error?.code === "23505" && row.consent_id) {
        const existing = await this.getAvatarByConsent(row.consent_id);
        if (existing) return existing;
      }
      fail("insert avatar", error);
    },
    async updateAvatar(id, patch) {
      const { data, error } = await db.from("avatars").update(patch).eq("id", id).select().maybeSingle();
      if (error) fail("update avatar", error);
      return (data as AvatarRow | null) ?? null;
    },
    async claimTwinCreate(id, at) {
      const { data, error } = await db
        .from("avatars")
        .update({ create_started_at: at })
        .eq("id", id)
        .is("heygen_group_id", null)
        .is("create_started_at", null)
        .select()
        .maybeSingle();
      if (error) fail("claim twin creation", error);
      return (data as AvatarRow | null) ?? null;
    },
    async insertOutbox(row) {
      const { error } = await db.from("email_outbox").insert(row);
      if (error) fail("save mocked email", error);
    },
    async hasOutbox(consentId, kind) {
      const { count, error } = await db
        .from("email_outbox")
        .select("id", { count: "exact", head: true })
        .eq("consent_id", consentId)
        .eq("kind", kind);
      if (error) fail("check mocked email", error);
      return (count ?? 0) > 0;
    },
  };
}

export type OutboxItem = { id: string; kind: string; to_email: string; subject: string; body: string; status: string; created_at: string };

/** Mocked emails for one consent (admin page only). */
export async function listOutboxForConsent(consentId: string): Promise<OutboxItem[]> {
  const { data, error } = await createAdminClient()
    .from("email_outbox")
    .select("id, kind, to_email, subject, body, status, created_at")
    .eq("consent_id", consentId)
    .order("created_at", { ascending: false });
  if (error) fail("list mocked emails", error);
  return (data ?? []) as OutboxItem[];
}

/** The PRIVATE consent-clips bucket. Browsers only ever get signed, short-lived URLs. */
export function createClipStorage(): ClipStorage {
  const bucket = createAdminClient().storage.from(CONSENT_BUCKET);
  return {
    async createUploadUrl(path) {
      const { data, error } = await bucket.createSignedUploadUrl(path);
      if (error || !data) fail("create upload URL", error);
      return { path: data.path, token: data.token };
    },
    async info(path) {
      const { data, error } = await bucket.info(path);
      if (error || !data) return null;
      return { size: data.size ?? 0, contentType: data.contentType ?? "" };
    },
    async signedUrl(path, seconds) {
      const { data, error } = await bucket.createSignedUrl(path, seconds);
      if (error || !data) fail("create playback URL", error);
      return data.signedUrl;
    },
    async download(path) {
      const { data, error } = await bucket.download(path);
      if (error || !data) fail("download clip", error);
      return new Uint8Array(await data.arrayBuffer());
    },
    async upload(path, bytes, contentType) {
      const { error } = await bucket.upload(path, bytes, { contentType, upsert: false });
      if (error) fail("upload converted clip", error);
    },
    async remove(path) {
      const { error } = await bucket.remove([path]);
      if (error) fail("remove clip", error);
    },
  };
}
