import type { ClipChecksResult } from "@/lib/clip-checks/evaluate";

// Rows and storage used by the consent and twin flow. The real versions use
// Supabase (lib/consent-store.ts); tests use tests/helpers/consent-memory.ts.

export type AdminStatus = "pending" | "approved" | "rejected";
export type ClipCheckStatus = "pending" | "running" | "done" | "failed";
export type AvatarStatus = "training" | "consent_pending" | "likeness_test" | "ready" | "reshoot_needed" | "failed";

export type ConsentRow = {
  id: string;
  brand_id: string;
  person_legal_name: string;
  checkbox_at: string;
  words: string[];
  words_expire_at: string;
  clip_path: string | null;
  clip_checks: ClipChecksResult | null;
  /** Decision 2: where the background clip check is (null = never started). */
  clip_check_status?: ClipCheckStatus | null;
  clip_check_error?: string | null;
  admin_status: AdminStatus;
  admin_note: string | null;
  heygen_consent_status: string | null;
  heygen_consent_url: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
};

export type NewConsentRow = Pick<
  ConsentRow,
  "brand_id" | "person_legal_name" | "checkbox_at" | "words" | "words_expire_at" | "ip" | "user_agent"
>;

export type ConsentPatch = Partial<
  Pick<
    ConsentRow,
    | "words"
    | "words_expire_at"
    | "clip_path"
    | "clip_checks"
    | "clip_check_status"
    | "clip_check_error"
    | "admin_status"
    | "admin_note"
    | "heygen_consent_status"
    | "heygen_consent_url"
  >
>;

export type AvatarRow = {
  id: string;
  brand_id: string;
  consent_id: string | null;
  heygen_group_id: string | null;
  heygen_look_id: string | null;
  voice_id: string | null;
  supported_engines: string[];
  status: AvatarStatus;
  error: string | null;
  /** Set just before the paid "create twin" POST (SF2 claim). */
  create_started_at: string | null;
  /** The engine picked in the likeness test (history; brands.engine is what renders use). */
  chosen_engine?: string | null;
  /** The likeness test decision: { decision, engine?, at, video_ids }. */
  likeness_test?: unknown;
  created_at: string;
};

export type AvatarPatch = Partial<
  Pick<
    AvatarRow,
    | "heygen_group_id"
    | "heygen_look_id"
    | "voice_id"
    | "supported_engines"
    | "status"
    | "error"
    | "create_started_at"
    | "chosen_engine"
    | "likeness_test"
  >
>;

export type OutboxRow = {
  brand_id: string | null;
  consent_id: string | null;
  to_email: string;
  kind: "consent_link" | "reshoot_tips";
  subject: string;
  body: string;
};

/** ownerEmail = the brand owner's login email; contactEmail = brands.contact_email (the client, decision 6). */
export type BrandContact = { id: string; name: string; ownerEmail: string | null; contactEmail: string | null };

export interface ConsentStore {
  getBrandContact(brandId: string): Promise<BrandContact | null>;
  /** Decision 6: the client's own email on the brand (done-for-you brands are admin-owned). */
  setBrandContactEmail(brandId: string, email: string): Promise<void>;
  insertConsent(row: NewConsentRow): Promise<ConsentRow>;
  getConsent(id: string): Promise<ConsentRow | null>;
  /** With onlyIfPending, changes nothing (returns null) unless admin_status is still pending. */
  updateConsent(id: string, patch: ConsentPatch, onlyIfPending?: boolean): Promise<ConsentRow | null>;
  /**
   * SF4: saves clip check results only if the consent is still pending AND
   * still has this clip_path. Returns null (nothing saved) otherwise.
   */
  saveClipChecks(id: string, clipPath: string, checks: ClipChecksResult): Promise<ConsentRow | null>;
  /**
   * Decision 5: replaces clip_path `from` with `to` (and clears clip_checks),
   * only while the consent is pending and still has `from`. Null otherwise.
   */
  swapClipPath(id: string, from: string, to: string): Promise<ConsentRow | null>;
  listConsents(): Promise<ConsentRow[]>;
  getAvatarByConsent(consentId: string): Promise<AvatarRow | null>;
  getAvatar(id: string): Promise<AvatarRow | null>;
  /** One avatar per consent: returns the existing row if there is one. */
  insertAvatar(row: Pick<AvatarRow, "brand_id" | "consent_id" | "status">): Promise<AvatarRow>;
  updateAvatar(id: string, patch: AvatarPatch): Promise<AvatarRow | null>;
  /**
   * Atomically claims "we are about to create the twin on HeyGen": sets
   * create_started_at only if heygen_group_id AND create_started_at are both
   * still null. Returns the row, or null when someone already claimed it.
   */
  claimTwinCreate(id: string, at: string): Promise<AvatarRow | null>;
  /** Mocked email: stored, never sent. */
  insertOutbox(row: OutboxRow): Promise<void>;
  hasOutbox(consentId: string, kind: OutboxRow["kind"]): Promise<boolean>;
}

/** The private consent-clips bucket. */
export interface ClipStorage {
  createUploadUrl(path: string): Promise<{ path: string; token: string }>;
  info(path: string): Promise<{ size: number; contentType: string } | null>;
  signedUrl(path: string, seconds: number): Promise<string>;
  download(path: string): Promise<Uint8Array>;
  /** Server-side upload (e.g. the mp4 converted from a .mov). Never overwrites. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
}
