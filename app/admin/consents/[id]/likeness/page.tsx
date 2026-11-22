import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/admin/action-button";
import { ActionForm } from "@/components/admin/action-form";
import { ClaimClearOrWait } from "@/components/admin/claim-clear-or-wait";
import { AdminPage } from "@/components/admin/admin-page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth";
import { isMockHeygen } from "@/lib/config";
import { createConsentStore } from "@/lib/consent-store";
import { likenessEngines, listLikenessTest } from "@/lib/likeness";
import { LIKENESS_LINE } from "@/lib/render";
import { createVideoFiles, createVideoStore } from "@/lib/video-store";
import { checkLikenessAction, chooseEngineAction, needsReshootAction, startLikenessTestAction } from "../../likeness-actions";

// Admin → Consents and twins → twin → "Likeness test" (Phase 3 item 6).
// The test videos side by side (5-minute signed links from the private
// bucket), "Use this engine" under each finished one, and "Needs reshoot".

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function LikenessPage({ params }: PageProps<"/admin/consents/[id]/likeness">) {
  return (
    <AdminPage title="Likeness test">
      <LikenessBackLink params={params} />
      <LikenessDetail params={params} />
    </AdminPage>
  );
}

async function LikenessBackLink({ params }: Pick<PageProps<"/admin/consents/[id]/likeness">, "params">) {
  await requireAdmin();
  const { id } = await params;
  return (
    <p className="text-sm">
      <Link href={UUID.test(id) ? `/admin/consents/${id}` : "/admin/consents"} className="text-muted-foreground hover:underline">
        ← Back to the consent and twin
      </Link>
    </p>
  );
}

async function LikenessDetail({ params }: Pick<PageProps<"/admin/consents/[id]/likeness">, "params">) {
  await requireAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const store = createConsentStore();
  const consent = await store.getConsent(id);
  if (!consent) notFound();
  const avatar = await store.getAvatarByConsent(consent.id);
  if (!avatar) {
    return <p className="text-sm">No twin yet for this consent.</p>;
  }
  const items = await listLikenessTest(avatar.id, { videos: createVideoStore(), files: createVideoFiles() });
  const engines = likenessEngines(avatar.supported_engines);
  const deciding = avatar.status === "likeness_test";
  const mock = isMockHeygen();

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Twin status: {avatar.status.replaceAll("_", " ")} · HeyGen consent: {consent.heygen_consent_status ?? "not started"} · Chosen
        engine: {avatar.chosen_engine ?? "none yet"}
      </p>

      <Card>
        <CardHeader>
          <CardTitle>1. Render the test line on each engine</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Engines to compare: {engines.length ? engines.join(", ") : "none of the realistic engines (check the twin)"}. Every video
            says the same line:
          </p>
          <blockquote className="border-l-2 pl-3 italic">{LIKENESS_LINE}</blockquote>
          <p className="text-muted-foreground">
            {mock
              ? "Mock mode: no HeyGen call, nothing is spent. The videos show the test clip."
              : `Real mode: this makes ${engines.length} paid HeyGen renders. Ask the owner first.`}
          </p>
          {deciding && (
            <div className="flex flex-wrap gap-4">
              <ActionForm
                action={startLikenessTestAction.bind(null, avatar.id)}
                label={items.length ? "Render missing ones" : "Start the likeness test"}
                pendingLabel="Starting…"
                confirmSpend={!mock}
              />
              {items.some((i) => i.video.status === "rendering") && (
                <ActionButton action={checkLikenessAction.bind(null, avatar.id)} label="Check HeyGen again" pendingLabel="Checking…" variant="outline" />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {items.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>2. Watch them side by side and pick the most realistic</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map(({ video, url }) => (
                <div key={video.id} className="space-y-2 rounded border p-2">
                  <p className="font-medium">{video.engine}</p>
                  {url ? (
                    // Signed URL, valid 5 minutes. Refresh the page to watch again later.
                    <video src={url} controls playsInline className="aspect-[9/16] w-full rounded bg-black" />
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      {video.status === "failed" ? `Failed: ${video.error ?? "no reason given"}` : `Status: ${video.status}`}
                    </p>
                  )}
                  {video.render_started_at && !video.heygen_video_id && (
                    <ClaimClearOrWait target="video" id={video.id} startedAt={video.render_started_at} status={video.status} />
                  )}
                  {deciding && url && video.engine && (
                    <ActionForm
                      action={chooseEngineAction.bind(null, avatar.id)}
                      label="Use this engine"
                      pendingLabel="Saving…"
                      hidden={{ engine: video.engine }}
                      size="sm"
                    />
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {deciding && (
        <Card>
          <CardHeader>
            <CardTitle>None of them looks real?</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <ActionButton action={needsReshootAction.bind(null, avatar.id)} label="Needs reshoot" pendingLabel="Saving…" variant="outline" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
