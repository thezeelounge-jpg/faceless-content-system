import { describe, expect, it } from "vitest";
import { clientEmailFor, consentLinkRecipients, reshootRecipients } from "@/lib/email-recipients";

// Decision 6 (done-for-you): HeyGen's consent link goes to the client's own
// email with a copy to the admins (ADMIN_EMAILS); reshoot tips go to the
// admins only. All of it is only rows in email_outbox (status 'mocked').

const ADMINS = ["zee@studio.example", "rowan@studio.example"];

describe("who is the client", () => {
  it("the contact email on the brand wins", () => {
    expect(clientEmailFor({ contactEmail: "Ayesha@Clinic.example", ownerEmail: "zee@studio.example" }, ADMINS)).toBe(
      "ayesha@clinic.example",
    );
  });

  it("else the brand owner, unless the owner is an admin (done-for-you brands are admin-owned)", () => {
    expect(clientEmailFor({ contactEmail: null, ownerEmail: "self@serve.example" }, ADMINS)).toBe("self@serve.example");
    expect(clientEmailFor({ contactEmail: null, ownerEmail: "ZEE@studio.example" }, ADMINS)).toBeNull();
    expect(clientEmailFor({ contactEmail: null, ownerEmail: null }, ADMINS)).toBeNull();
  });
});

describe("recipients", () => {
  it("consent link: the client first, then a copy for each admin, no duplicates", () => {
    expect(consentLinkRecipients("ayesha@clinic.example", ADMINS)).toEqual([
      { to: "ayesha@clinic.example", copy: false },
      { to: "zee@studio.example", copy: true },
      { to: "rowan@studio.example", copy: true },
    ]);
    expect(consentLinkRecipients("zee@studio.example", ADMINS)).toEqual([
      { to: "zee@studio.example", copy: false },
      { to: "rowan@studio.example", copy: true },
    ]);
  });

  it("consent link without a client email: admin copies only", () => {
    expect(consentLinkRecipients(null, ADMINS)).toEqual([
      { to: "zee@studio.example", copy: true },
      { to: "rowan@studio.example", copy: true },
    ]);
  });

  it("reshoot tips: admins only, never the client", () => {
    expect(reshootRecipients(ADMINS)).toEqual(["zee@studio.example", "rowan@studio.example"]);
    expect(reshootRecipients([])).toEqual([]);
  });
});
