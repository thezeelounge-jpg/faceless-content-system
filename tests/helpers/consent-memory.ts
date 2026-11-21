import { readFileSync } from "node:fs";
import path from "node:path";
import type { AvatarRow, ClipStorage, ConsentRow, ConsentStore, OutboxRow } from "@/lib/consent-store-types";

// In-memory stand-ins for the consents/avatars/email_outbox tables and the
// private consent-clips bucket, so the flow can be tested without Supabase.

export const BRAND_ID = "10000000-0000-0000-0000-000000000001";

export function memoryConsentStore() {
  const consents: ConsentRow[] = [];
  const avatars: AvatarRow[] = [];
  const outbox: (OutboxRow & { status: "mocked" })[] = [];
  let n = 0;
  const id = (prefix: string) => `${prefix}000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  /** brands.contact_email for BRAND_ID (decision 6). */
  let contactEmail: string | null = null;

  const store: ConsentStore = {
    async getBrandContact(brandId) {
      return brandId === BRAND_ID
        ? { id: BRAND_ID, name: "Dr Ayesha Clinic", ownerEmail: "owner@example.com", contactEmail }
        : null;
    },
    async setBrandContactEmail(brandId, email) {
      if (brandId === BRAND_ID) contactEmail = email;
    },
    async insertConsent(row) {
      const saved: ConsentRow = {
        id: id("c0"),
        clip_path: null,
        clip_checks: null,
        admin_status: "pending",
        admin_note: null,
        heygen_consent_status: null,
        heygen_consent_url: null,
        created_at: new Date().toISOString(),
        ...row,
      };
      consents.push(saved);
      return { ...saved };
    },
    async getConsent(consentId) {
      const row = consents.find((c) => c.id === consentId);
      return row ? structuredClone(row) : null;
    },
    async updateConsent(consentId, patch, onlyIfPending = false) {
      const row = consents.find((c) => c.id === consentId);
      if (!row || (onlyIfPending && row.admin_status !== "pending")) return null;
      Object.assign(row, structuredClone(patch));
      return structuredClone(row);
    },
    async saveClipChecks(consentId, clipPath, checks) {
      const row = consents.find((c) => c.id === consentId);
      if (!row || row.clip_path !== clipPath || row.admin_status !== "pending") return null;
      row.clip_checks = structuredClone(checks);
      return structuredClone(row);
    },
    async swapClipPath(consentId, from, to) {
      const row = consents.find((c) => c.id === consentId);
      if (!row || row.clip_path !== from || row.admin_status !== "pending") return null;
      Object.assign(row, { clip_path: to, clip_checks: null });
      return structuredClone(row);
    },
    async listConsents() {
      return structuredClone(consents);
    },
    async getAvatarByConsent(consentId) {
      const row = avatars.find((a) => a.consent_id === consentId);
      return row ? structuredClone(row) : null;
    },
    async getAvatar(avatarId) {
      const row = avatars.find((a) => a.id === avatarId);
      return row ? structuredClone(row) : null;
    },
    async insertAvatar(row) {
      const existing = avatars.find((a) => a.consent_id === row.consent_id);
      if (existing) return structuredClone(existing);
      const saved: AvatarRow = {
        id: id("a0"),
        heygen_group_id: null,
        heygen_look_id: null,
        voice_id: null,
        supported_engines: [],
        error: null,
        create_started_at: null,
        created_at: new Date().toISOString(),
        ...row,
      };
      avatars.push(saved);
      return structuredClone(saved);
    },
    async updateAvatar(avatarId, patch) {
      const row = avatars.find((a) => a.id === avatarId);
      if (!row) return null;
      Object.assign(row, structuredClone(patch));
      return structuredClone(row);
    },
    async claimTwinCreate(avatarId, at) {
      const row = avatars.find((a) => a.id === avatarId);
      if (!row || row.heygen_group_id !== null || row.create_started_at !== null) return null;
      row.create_started_at = at;
      return structuredClone(row);
    },
    async insertOutbox(row) {
      outbox.push({ ...row, status: "mocked" });
    },
    async hasOutbox(consentId, kind) {
      return outbox.some((o) => o.consent_id === consentId && o.kind === kind);
    },
  };
  const setContactEmail = (email: string | null) => {
    contactEmail = email;
  };
  const getContactEmail = () => contactEmail;
  return { store, consents, avatars, outbox, setContactEmail, getContactEmail };
}

/** The private bucket: uploads land here; downloads read the fixture clips. */
export function memoryClipStorage(files: Record<string, { size: number; contentType: string; fixture?: string }> = {}) {
  const uploadUrls: string[] = [];
  const signed: { path: string; seconds: number }[] = [];
  /** Bytes our server code uploaded (e.g. a .mov converted to mp4). */
  const uploaded: Record<string, Uint8Array> = {};
  const removed: string[] = [];
  const storage: ClipStorage = {
    async upload(objectPath, bytes, contentType) {
      uploaded[objectPath] = bytes;
      files[objectPath] = { size: bytes.byteLength, contentType };
    },
    async remove(objectPath) {
      removed.push(objectPath);
      delete files[objectPath];
    },
    async createUploadUrl(objectPath) {
      uploadUrls.push(objectPath);
      return { path: objectPath, token: `token-for-${objectPath}` };
    },
    async info(objectPath) {
      const file = files[objectPath];
      return file ? { size: file.size, contentType: file.contentType } : null;
    },
    async signedUrl(objectPath, seconds) {
      signed.push({ path: objectPath, seconds });
      return `https://storage.example.invalid/signed/${objectPath}?expires=${seconds}`;
    },
    async download(objectPath) {
      if (uploaded[objectPath]) return uploaded[objectPath];
      const fixture = files[objectPath]?.fixture;
      if (!fixture) throw new Error(`no such object: ${objectPath}`);
      return new Uint8Array(readFileSync(path.resolve("tests/fixtures", fixture)));
    },
  };
  return { storage, files, uploadUrls, signed, uploaded, removed };
}
