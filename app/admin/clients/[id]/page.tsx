import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminPage } from "@/components/admin/admin-page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProfileEditForm, WriteProfileButton } from "@/components/admin/brand-profile-forms";
import { pillarSchema } from "@/lib/ai-schemas";
import {
  AUTOPILOT_LEVELS,
  COUNTRIES,
  LANGUAGES,
  NICHE_PRESETS,
  soundAnswerList,
  splitSamples,
  WEEKDAYS,
} from "@/lib/brand-input";
import { ActionButton } from "@/components/admin/action-button";
import { PlanGrid, PlanList } from "@/components/admin/plan-view";
import { getBrand, listBrandVersions } from "@/lib/brands";
import { timezoneFor } from "@/lib/posting-times";
import { listPosts } from "@/lib/posts";
import { canRunChecks, latestScript } from "@/lib/qa/can-run-checks";
import { checkScript, generateBrandProfile, planNextFourWeeks, saveProfileEdit, writeScript } from "./actions";

export default function BrandPage({ params }: PageProps<"/admin/clients/[id]">) {
  return (
    <AdminPage title="Client">
      <p className="text-sm">
        <Link href="/admin/clients" className="text-muted-foreground hover:underline">
          ← All clients
        </Link>
      </p>
      <BrandDetail params={params} />
    </AdminPage>
  );
}

async function BrandDetail({ params }: Pick<PageProps<"/admin/clients/[id]">, "params">) {
  const { id } = await params;
  const brand = await getBrand(id);
  if (!brand) notFound();

  const label = <T extends { value: string | number; label: string }>(list: readonly T[], value: unknown) =>
    list.find((item) => item.value === value)?.label ?? String(value ?? "—");

  const parsedPillars = pillarSchema.array().safeParse(brand.pillars);
  const pillars = parsedPillars.success ? parsedPillars.data : [];
  const versions = await listBrandVersions(brand.id);
  const hasProfile = brand.current_version > 0 && Boolean(brand.profile_md);
  const samples = splitSamples(brand.samples);
  const timezone = timezoneFor(brand.audience_countries);
  const posts = await listPosts(brand.id);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">{brand.name}</h2>
      <p className="text-sm">
        <Link href={`/admin/clients/${brand.id}/names`} className="underline">
          How to say names →
        </Link>
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Brand profile {hasProfile ? `· version ${brand.current_version}` : ""}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {hasProfile ? (
            <>
              <div className="bg-muted/40 rounded-lg p-3 text-sm break-words whitespace-pre-wrap">{brand.profile_md}</div>
              <div>
                <h3 className="text-sm font-medium">Pillars</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                  {pillars.map((pillar) => (
                    <li key={pillar.name}>
                      <span className="font-medium">{pillar.name}:</span> {pillar.description}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">No profile yet. Claude writes one from the answers below.</p>
          )}
          <WriteProfileButton action={generateBrandProfile.bind(null, brand.id)} hasProfile={hasProfile} />
        </CardContent>
      </Card>

      {hasProfile && (
        <Card>
          <CardHeader>
            <CardTitle>Edit profile</CardTitle>
          </CardHeader>
          <CardContent>
            <ProfileEditForm
              key={brand.current_version}
              action={saveProfileEdit.bind(null, brand.id)}
              profileMd={brand.profile_md ?? ""}
              pillars={pillars}
            />
          </CardContent>
        </Card>
      )}

      {versions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Profile history</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-border divide-y text-sm">
              {versions.map((v) => (
                <li key={v.id} className="flex justify-between py-1.5">
                  <span>
                    Version {v.version} · {v.source === "generated" ? "written by Claude" : "edited"}
                  </span>
                  <span className="text-muted-foreground">{new Date(v.created_at).toISOString().slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Times are local to {label(COUNTRIES, brand.audience_countries[0] ?? "PK")} ({timezone}).
          </p>
          <ActionButton
            action={planNextFourWeeks.bind(null, brand.id)}
            label="Plan next 4 weeks"
            pendingLabel="Planning… (up to a few minutes)"
            size="lg"
          />
          {posts.length > 0 ? (
            <>
              <PlanGrid posts={posts} timezone={timezone} />
              <PlanList
                posts={posts}
                timezone={timezone}
                actions={(post) => {
                  if (post.status === "planned" && post.scripts.length === 0) {
                    return (
                      <ActionButton
                        action={writeScript.bind(null, post.id)}
                        label="Write script"
                        pendingLabel="Writing and checking… (a few minutes)"
                        variant="outline"
                        size="sm"
                      />
                    );
                  }
                  // Same rule as the checkScript action (lib/qa/can-run-checks.ts).
                  const latest = latestScript(post.scripts);
                  return latest && canRunChecks(post.scripts, post) ? (
                    <ActionButton
                      action={checkScript.bind(null, latest.id)}
                      label="Run checks"
                      pendingLabel="Checking… (up to a few minutes)"
                      variant="outline"
                      size="sm"
                    />
                  ) : null;
                }}
              />
            </>
          ) : (
            <p className="text-muted-foreground text-sm">No posts planned yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Onboarding answers</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            <Row term="Niche">{label(NICHE_PRESETS, brand.niche)}</Row>
            <Row term="Audience">{brand.audience}</Row>
            <Row term="Offers">{brand.offers}</Row>
            <Row term="Tone">{brand.tone}</Row>
            <Row term="Language">{label(LANGUAGES, brand.language)}</Row>
            <Row term="Posting">
              {brand.posts_per_week} a week on {brand.posting_days.map((d) => label(WEEKDAYS, d)).join(", ")}
            </Row>
            <Row term="Countries">{brand.audience_countries.map((c) => label(COUNTRIES, c)).join(", ")}</Row>
            <Row term="Autopilot">{label(AUTOPILOT_LEVELS, brand.autopilot_level)}</Row>
            <Row term="Banned words">{brand.banned_words.join(", ") || "None"}</Row>
          </dl>
          <h3 className="mt-4 text-sm font-medium">How they sound</h3>
          <dl className="mt-1 space-y-2 text-sm">
            {soundAnswerList(brand.sound_answers).map((item) => (
              <div key={item.question}>
                <dt className="text-muted-foreground">{item.question}</dt>
                <dd className="break-words whitespace-pre-wrap">{item.answer}</dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-4 text-sm font-medium">Writing samples ({samples.length})</h3>
          {samples.length > 0 ? (
            <ol className="mt-1 list-decimal space-y-2 pl-5 text-sm">
              {samples.map((sample, i) => (
                <li key={i} className="break-words whitespace-pre-wrap">
                  {sample}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted-foreground text-sm">None saved.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="break-words whitespace-pre-wrap">{children}</dd>
    </>
  );
}
