import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/admin/action-button";
import { AdminPage } from "@/components/admin/admin-page";
import { ClaimClearOrWait } from "@/components/admin/claim-clear-or-wait";
import { NoteForm } from "@/components/admin/consent-forms";
import { ConsentUpload } from "@/components/admin/consent-upload";
import { RecordingGuide } from "@/components/admin/recording-guide";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth";
import { getSupabasePublicConfig } from "@/lib/config";
import { clipCheckStatusLine } from "@/lib/clip-check-status";
import { clipPlaybackUrl } from "@/lib/consent-flow";
import { createClipStorage, createConsentStore, listOutboxForConsent } from "@/lib/consent-store";
import { wordsExpired } from "@/lib/consent-words";
import {
  approveConsentAction,
  checkTwinAction,
  confirmUploadAction,
  newWordsAction,
  prepareUploadAction,
  recheckClipAction,
  rejectConsentAction,
  startTwinAction,
} from "../actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ConsentPage({ params }: PageProps<"/admin/consents/[id]">) {
  return (
    <AdminPage title="Consent clip">
      <p className="text-sm">
        <Link href="/admin/consents" className="text-muted-foreground hover:underline">
          ← All consents and twins
        </Link>
      </p>
      <ConsentDetail params={params} />
    </AdminPage>
  );
}

async function ConsentDetail({ params }: Pick<PageProps<"/admin/consents/[id]">, "params">) {
  await requireAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const store = createConsentStore();
  const consent = await store.getConsent(id);
  if (!consent) notFound();
  const [brand, avatar, emails, videoUrl] = await Promise.all([
    store.getBrandContact(consent.brand_id),
    store.getAvatarByConsent(consent.id),
    listOutboxForConsent(consent.id),
    clipPlaybackUrl(consent, createClipStorage()),
  ]);
  const supabase = getSupabasePublicConfig();
  const pending = consent.admin_status === "pending";
  const expired = wordsExpired(consent.words_expire_at);
  // SF4: results for another clip (or saved before clip_path was recorded) don't count.
  const checks = consent.clip_checks?.clip_path === consent.clip_path ? consent.clip_checks : null;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">
        {brand?.name ?? "Client"}: {consent.person_legal_name}
      </h2>
      <p className="text-muted-foreground text-sm">
        Status: {consent.admin_status}
        {consent.admin_note ? ` · Note: ${consent.admin_note}` : ""} · Agreed{" "}
        {new Date(consent.checkbox_at).toLocaleString("en-GB")} · IP {consent.ip ?? "unknown"}
      </p>

      <Card>
        <CardHeader>
          <CardTitle>The 3 words (say them first, looking at the camera)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-2xl font-semibold tracking-wide">{consent.words.join(" · ")}</p>
          <p className="text-muted-foreground text-sm">
            {expired
              ? "These words have expired. Get new words before recording."
              : `Valid until ${new Date(consent.words_expire_at).toLocaleTimeString("en-GB")}.`}
          </p>
          {pending && <ActionButton action={newWordsAction.bind(null, consent.id)} label="New words" pendingLabel="Picking…" variant="outline" size="sm" />}
        </CardContent>
      </Card>

      {pending && !expired && supabase && (
        <Card>
          <CardHeader>
            <CardTitle>Record or upload the clip</CardTitle>
          </CardHeader>
          <CardContent>
            <ConsentUpload
              consentId={consent.id}
              supabaseUrl={supabase.url}
              supabaseKey={supabase.publishableKey}
              prepare={prepareUploadAction}
              confirm={confirmUploadAction}
            />
          </CardContent>
        </Card>
      )}

      {videoUrl && (
        <Card>
          <CardHeader>
            <CardTitle>The clip</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Signed URL, valid 5 minutes. Refresh the page to watch again later. */}
            <video src={videoUrl} controls playsInline className="aspect-[9/16] w-full max-w-[320px] rounded bg-black" />
          </CardContent>
        </Card>
      )}

      {consent.clip_path && (
        <Card>
          <CardHeader>
            <CardTitle>Automatic checks {checks ? (checks.passed ? "— all passed" : "— reshoot needed") : "— not run yet"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground text-sm">Check status: {clipCheckStatusLine(consent)}</p>
            {checks && (
              <ul className="space-y-1 text-sm">
                {checks.checks.map((c) => (
                  <li key={c.code}>
                    <span className={c.passed ? "" : "text-destructive font-medium"}>
                      {c.passed ? "✓" : "✗"} {c.label}
                    </span>{" "}
                    <span className="text-muted-foreground">({c.value})</span>
                    {c.tip && <div className="pl-5">Tip: {c.tip}</div>}
                  </li>
                ))}
              </ul>
            )}
            {pending && (
              <ActionButton action={recheckClipAction.bind(null, consent.id)} label="Run checks" pendingLabel="Starting the checks…" variant="outline" size="sm" />
            )}
          </CardContent>
        </Card>
      )}

      {pending && consent.clip_path && (
        <Card>
          <CardHeader>
            <CardTitle>Decide</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <NoteForm action={approveConsentAction.bind(null, consent.id)} label="Approve" pendingLabel="Approving…" noteRequired={false} />
            <NoteForm action={rejectConsentAction.bind(null, consent.id)} label="Reject" pendingLabel="Rejecting…" noteRequired variant="outline" />
          </CardContent>
        </Card>
      )}

      {consent.admin_status === "approved" && (
        <Card>
          <CardHeader>
            <CardTitle>Twin</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {avatar ? (
              <>
                <p>
                  Status: {avatar.status.replaceAll("_", " ")} · HeyGen consent: {consent.heygen_consent_status ?? "not started"}
                </p>
                <p className="text-muted-foreground">
                  Look: {avatar.heygen_look_id ?? "—"} · Voice: {avatar.voice_id ?? "—"} · Engines:{" "}
                  {avatar.supported_engines.length ? avatar.supported_engines.join(", ") : "—"}
                </p>
                {avatar.error && <p className="text-destructive">{avatar.error}</p>}
                {avatar.create_started_at && !avatar.heygen_group_id && (
                  <ClaimClearOrWait target="twin" id={avatar.id} startedAt={avatar.create_started_at} status={avatar.status} />
                )}
              </>
            ) : (
              <p>No twin yet.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {!avatar?.heygen_group_id && (
                <ActionButton action={startTwinAction.bind(null, consent.id)} label="Create twin" pendingLabel="Starting…" size="sm" />
              )}
              {avatar?.heygen_group_id && (
                <ActionButton action={checkTwinAction.bind(null, avatar.id)} label="Check twin again" pendingLabel="Checking…" variant="outline" size="sm" />
              )}
            </div>
            {avatar && ["likeness_test", "ready", "reshoot_needed"].includes(avatar.status) && (
              <p>
                <Link href={`/admin/consents/${consent.id}/likeness`} className="font-medium underline">
                  Likeness test →
                </Link>{" "}
                {avatar.chosen_engine ? `(chosen engine: ${avatar.chosen_engine})` : ""}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {emails.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Emails (mock: stored, not sent)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {emails.map((email) => (
              <div key={email.id} className="rounded border p-2">
                <p className="font-medium">
                  {email.subject} → {email.to_email}
                </p>
                <p className="text-muted-foreground whitespace-pre-wrap">{email.body}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <RecordingGuide />
    </div>
  );
}
