import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runClaudeTask, type ClaudeContext, type ClaudeTaskName } from "@/lib/claude";
import { createHeygenClient } from "@/lib/heygen";
import { runAudioGate, type AudioGateDeps, type AudioMeasure } from "@/lib/qa/audio-gate";
import { NEEDS_SPEND_CONFIRM, renderVideo } from "@/lib/render";
import type { SttProvider } from "@/lib/stt";
import { memoryPipeline } from "@/tests/helpers/pipeline-memory";
import misheard from "@/tests/fixtures/stt/gate3-ayesha-misheard.json";

// Gate 3 (QA-SPEC "Gate 3: Audio and pronunciation QA") with mocks only: MOCK_STT (the transcript is
// picked by the spoken text, tests/fixtures/stt/by-text.json), MOCK_CLAUDE (key_term_check answers
// from tests/fixtures/stt/key-term-judgements.json), MOCK_HEYGEN (the in-memory mock render path with
// the spend guard). No ffmpeg here: the audio measurements are injected.

const planSlots = vi.hoisted(() => ({ reserve: vi.fn(async () => {}), release: vi.fn(async () => {}) }));
vi.mock("@/lib/plan-slots", () => ({
  reservePlanSlot: planSlots.reserve,
  releasePlanSlot: planSlots.release,
  confirmPlanSlot: vi.fn(async () => {}),
}));

const AYESHA = {
  displayText: "Hi, I'm Ayesha from Bright Smile Dental. Brush twice a day and floss once. Book your free check-up today.",
  hook: "Hi, I'm Ayesha from Bright Smile Dental.",
  cta: "Book your free check-up today.",
};
const SAMEER = { ...AYESHA, displayText: AYESHA.displayText.replace("Ayesha", "Sameer"), hook: AYESHA.hook.replace("Ayesha", "Sameer") };

const healthy: AudioMeasure = { durationS: 7.6, silences: [], astats: { peakDb: -3.2, peakCount: 2 } };
const run = <T extends ClaudeTaskName>(task: T, ctx: ClaudeContext<T>) => runClaudeTask(task, ctx, { logUsage: async () => {} });

function setup(opts: Parameters<typeof memoryPipeline>[0] = {}) {
  const p = memoryPipeline(opts);
  const deps = (over: Partial<AudioGateDeps> = {}): AudioGateDeps => ({
    store: p.store,
    files: p.files,
    run,
    render: p.render,
    measureAudio: async () => healthy,
    ...over,
  });
  return { p, deps };
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is not allowed in tests"));
  for (const name of ["MOCK_HEYGEN", "MOCK_STT", "MOCK_CLAUDE", "MOCK_PEXELS"]) vi.stubEnv(name, "");
  planSlots.reserve.mockClear();
  planSlots.release.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Gate 3 passes", () => {
  it("a render that says every word right: one passed qa_reports row, transcript saved, video and post in audio_qa", async () => {
    const { p, deps } = setup();
    const { postId } = await p.seedPost({ ...AYESHA, dictionary: [{ written: "Ayesha", say_as: "Aa-ee-sha", status: "approved" }] });
    const videoId = await p.makeVideo(postId);
    const out = await runAudioGate(videoId, deps());
    expect(out.status).toBe("passed");
    expect(p.reports).toEqual([
      { video_id: videoId, script_id: expect.any(String), gate: "audio", passed: true, score: 0, issues: [], auto_fix: null },
    ]);
    expect(p.video(videoId)?.status).toBe("audio_qa");
    expect(p.v.posts[0].status).toBe("audio_qa");
    expect(p.extra(p.video(videoId)!).transcript).toMatchObject({ words: expect.any(Array) });
  });

  it("Roman Urdu: a name spelled another way by speech-to-text is the same sound (Claude FAST fixture) → a soft note, still passes", async () => {
    const { p, deps } = setup({ language: "roman_urdu" });
    const { postId } = await p.seedPost(AYESHA);
    const videoId = await p.makeVideo(postId);
    const aisha = structuredClone(misheard);
    aisha.words[2].text = "aisha";
    const stt: SttProvider = { transcribe: async () => aisha };
    const out = await runAudioGate(videoId, deps({ stt }));
    expect(out.status).toBe("passed");
    expect(p.reports[0].passed).toBe(true);
    expect(p.reports[0].issues).toEqual([
      expect.objectContaining({ code: "key_term_same_sound", severity: "soft", at_seconds: 0.96, detail: expect.stringContaining('"aisha"') }),
    ]);
    expect(p.pronunciations).toEqual([]);
  });

  it("only a rendered (or audio_qa) post video is checked", async () => {
    const { p, deps } = setup();
    const { postId } = await p.seedPost(AYESHA);
    const videoId = await p.makeVideo(postId);
    p.video(videoId)!.status = "final_qa";
    expect(await runAudioGate(videoId, deps())).toMatchObject({ status: "skipped" });
    expect(p.reports).toEqual([]);
  });
});

describe("DONE-WHEN: a script with a mispronounced name is caught by Gate 3, fixed with a respelling, and re-rendered once automatically", () => {
  it("caught → respelled → spoken_text regenerated → ONE mock re-render (never counted) → Gate 3 passes → on to the edit", async () => {
    const { p, deps } = setup({ spendCaps: { render: 1 } });
    const { postId, scriptId } = await p.seedPost(AYESHA);
    const createVideo = vi.spyOn(p.heygen, "createVideo");
    const first = await p.makeVideo(postId);
    expect(planSlots.reserve).toHaveBeenCalledTimes(1); // the customer's one video reserves one slot

    // Gate 3 run #1: the mock STT heard "asia" where the script says "Ayesha".
    const out = await runAudioGate(first, deps());
    expect(out.status).toBe("rerendering");
    if (out.status !== "rerendering") throw new Error("unreachable");
    expect(p.reports).toHaveLength(1);
    expect(p.reports[0]).toMatchObject({ video_id: first, gate: "audio", passed: false, auto_fix: null });
    expect(p.reports[0].issues).toContainEqual({
      code: "key_term",
      severity: "hard",
      at_seconds: 0.96,
      detail: '"Ayesha" (person) was heard as "asia" at 0.96 s.',
    });

    // Fixed with a respelling: an APPROVED dictionary row, source qa; spoken_text regenerated with it.
    expect(p.pronunciations).toEqual([{ brand_id: p.v.brands[0].id, written: "Ayesha", say_as: "Aa-ee-sha", status: "approved", source: "qa" }]);
    const spoken = p.v.scripts.find((s) => s.id === scriptId)!.spoken_text!;
    expect(spoken).toContain("Aa-ee-sha from Bright Smile Dental");
    expect(spoken).not.toContain("Ayesha");

    // Re-rendered ONCE through the normal render path (mock HeyGen + spend guard).
    const second = out.videoId;
    expect(second).not.toBe(first);
    expect(createVideo).toHaveBeenCalledTimes(2);
    expect(createVideo.mock.calls[1][0].spokenText).toContain("Aa-ee-sha");
    expect(p.v.videos.map((r) => [r.id, r.status, r.attempt, r.counts_toward_plan])).toEqual([
      [first, "failed", 1, false],
      [second, "rendering", 2, false],
    ]);
    expect(p.extras.get(second)).toMatchObject({ rerender_of: first, qa_fix_note: "Re-rendered once with a new respelling: Ayesha → Aa-ee-sha." });
    expect(planSlots.reserve).toHaveBeenCalledTimes(1); // our re-render reserves no plan slot
    // provider_usage: two mock rows (cost 0) that never count toward the daily cap (cap 1, two renders went through).
    expect(p.spend.rows.map((r) => [r.kind, r.video_id, r.mock, r.cost_usd, r.status])).toEqual([
      ["render", first, true, 0, "succeeded"],
      ["render", second, true, 0, "succeeded"],
    ]);
    expect(p.spend.rows.filter((r) => !r.mock)).toEqual([]);

    // The re-render finishes; Gate 3 run #2 hears the name right.
    await p.finishRender(second);
    const again = await runAudioGate(second, deps());
    expect(again.status).toBe("passed");
    expect(p.reports).toHaveLength(2);
    expect(p.reports[1]).toEqual({
      video_id: second, script_id: scriptId, gate: "audio", passed: true, score: 0, issues: [],
      auto_fix: "Re-rendered once with a new respelling: Ayesha → Aa-ee-sha.",
    });
    expect(p.video(second)).toMatchObject({ status: "audio_qa", counts_toward_plan: false });
    expect(p.v.posts[0]).toMatchObject({ status: "audio_qa", status_reason: null });
    expect(createVideo).toHaveBeenCalledTimes(2); // exactly one extra render
  });
});

describe("Gate 3 failures go to the team, never to the customer", () => {
  it("forced double fail: the re-render still mispronounces → team_review with the words and times; no third render; not counted", async () => {
    const { p, deps } = setup({ personName: "Sameer Ali" });
    const { postId } = await p.seedPost(SAMEER);
    const createVideo = vi.spyOn(p.heygen, "createVideo");
    const first = await p.makeVideo(postId);
    const out = await runAudioGate(first, deps());
    expect(out.status).toBe("rerendering");
    const second = (out as { videoId: string }).videoId;
    await p.finishRender(second);

    const again = await runAudioGate(second, deps());
    expect(again.status).toBe("team_review");
    expect(createVideo).toHaveBeenCalledTimes(2);
    expect(p.reports.map((r) => r.passed)).toEqual([false, false]);
    expect(p.reports[1].auto_fix).toBe("Re-rendered once with a new respelling: Sameer → Sa-meer.");
    expect(p.reports[1].issues).toContainEqual(expect.objectContaining({ code: "key_term", at_seconds: 0.96, detail: '"Sameer" (person) was heard as "same ear" at 0.96 s.' }));
    expect(p.video(second)).toMatchObject({ status: "team_review", counts_toward_plan: false });
    expect(p.video(first)).toMatchObject({ status: "failed", counts_toward_plan: false });
    const post = p.v.posts[0];
    expect(post.status).toBe("team_review");
    expect(post.status_reason).toContain('"Sameer" (person) was heard as "same ear" at 0.96 s');
    expect(post.status_reason).toMatch(/^Audio check failed after one re-render/);
    expect(p.v.videos).toHaveLength(2);
  });

  it("a problem a re-render can't fix (longer than the plan allows) goes straight to the team", async () => {
    const { p, deps } = setup({ maxSeconds: 5 });
    const { postId } = await p.seedPost({ ...AYESHA, dictionary: [{ written: "Ayesha", say_as: "Aa-ee-sha", status: "approved" }] });
    const videoId = await p.makeVideo(postId);
    const out = await runAudioGate(videoId, deps());
    expect(out.status).toBe("team_review");
    expect(p.reports[0].issues.map((i) => i.code)).toContain("duration_max");
    expect(p.v.videos).toHaveLength(1);
    expect(p.v.posts[0].status).toBe("team_review");
  });

  it("a long silence: one re-render without a dictionary change (spoken_text unchanged)", async () => {
    const { p, deps } = setup();
    const { postId, scriptId } = await p.seedPost({ ...AYESHA, dictionary: [{ written: "Ayesha", say_as: "Aa-ee-sha", status: "approved" }] });
    const videoId = await p.makeVideo(postId);
    const before = p.v.scripts.find((s) => s.id === scriptId)!.spoken_text;
    const silent: AudioMeasure = { ...healthy, silences: [{ start_s: 3.0, end_s: 4.4 }] };
    const out = await runAudioGate(videoId, deps({ measureAudio: async () => silent }));
    expect(out.status).toBe("rerendering");
    expect(p.reports[0].issues).toContainEqual(expect.objectContaining({ code: "silence", at_seconds: 3 }));
    expect(p.v.scripts.find((s) => s.id === scriptId)!.spoken_text).toBe(before);
    expect(p.pronunciations.filter((x) => x.source === "qa")).toEqual([]);
    expect(p.extras.get((out as { videoId: string }).videoId)?.qa_fix_note).toBe("Re-rendered once (silence).");
  });

});

// p5-b1 (QA SF4 + Rowan 1): the real render path, not an injected error. A REAL (mock: false) HeyGen
// client whose fetch always rejects: if anything reached the network, the stub would be called.
describe("Gate 3 re-render with real HeyGen (no network: the fetch stub always rejects)", () => {
  function realSetup() {
    const s = setup();
    const fetchStub = vi.fn(async () => {
      throw new Error("network is not allowed in tests");
    });
    const real = createHeygenClient({ mock: false, apiKey: undefined, fetch: fetchStub as unknown as typeof fetch });
    const realRender = (id: string, confirmSpend?: boolean) =>
      renderVideo(id, { videos: s.p.v.store, heygen: real, spend: s.p.spend.store, ...(confirmSpend ? { confirmSpend } : {}) });
    return { ...s, fetchStub, realRender };
  }

  /** Mock first render → Gate 3 (misheard name) → the automatic re-render through the REAL renderVideo. */
  async function blockedRerender(r: ReturnType<typeof realSetup>) {
    const { postId } = await r.p.seedPost(AYESHA);
    const first = await r.p.makeVideo(postId);
    planSlots.reserve.mockClear();
    const out = await runAudioGate(first, r.deps({ render: (id) => r.realRender(id) }));
    return { out, second: r.p.v.videos[1] };
  }

  it("without the admin's OK: rerender_blocked, the attempt-2 video stays queued (not counted), no spend row, no fetch", async () => {
    const r = realSetup();
    const { out, second } = await blockedRerender(r);
    expect(out.status).toBe("rerender_blocked");
    expect(second).toMatchObject({ status: "queued", attempt: 2, counts_toward_plan: false, heygen_video_id: null, render_started_at: null });
    // approved: "Make video" returns this queued re-render (createPostRender 'existing') and asks for "I agree to spend".
    expect(r.p.v.posts[0].status).toBe("approved");
    expect(r.p.v.posts[0].status_reason).toContain(NEEDS_SPEND_CONFIRM);
    expect(r.p.v.posts[0].status_reason).toContain("A real render needs an admin's OK");
    expect(r.p.spend.rows.filter((row) => row.video_id === second.id)).toEqual([]);
    expect(planSlots.reserve).not.toHaveBeenCalled();
    expect(r.fetchStub).not.toHaveBeenCalled();
  });

  it("Rowan 1: the admin confirms, but renders are paused → the spend guard refuses: still queued, no spend row, no fetch", async () => {
    const r = realSetup();
    const { second } = await blockedRerender(r);
    r.p.spend.settings.rendersPaused = true;
    await expect(r.realRender(second.id, true)).rejects.toThrow(/paused/i);
    expect(r.p.video(second.id)).toMatchObject({ status: "queued", heygen_video_id: null, render_started_at: null, counts_toward_plan: false });
    expect(r.p.spend.rows.filter((row) => row.video_id === second.id)).toEqual([]);
    expect(planSlots.reserve).not.toHaveBeenCalled();
    expect(r.fetchStub).not.toHaveBeenCalled();
  });

  it("Rowan 1: the admin confirms, but a REAL (non-mock) render already used today's cap → refused, renders paused, no fetch", async () => {
    const r = realSetup();
    const { second } = await blockedRerender(r);
    r.p.spend.settings.caps = { render: 1 };
    r.p.spend.seed("render", new Date().toISOString(), 1);
    const rowsBefore = r.p.spend.rows.length;
    await expect(r.realRender(second.id, true)).rejects.toThrow();
    expect(r.p.spend.settings.rendersPaused).toBe(true);
    expect(r.p.spend.rows).toHaveLength(rowsBefore);
    expect(r.p.video(second.id)).toMatchObject({ status: "queued", heygen_video_id: null, render_started_at: null });
    expect(r.fetchStub).not.toHaveBeenCalled();
  });

  it("Rowan 1: the mock first render's spend row is a mock row and never counts toward that cap", async () => {
    const r = realSetup();
    await blockedRerender(r);
    expect(r.p.spend.rows.filter((row) => row.kind === "render").every((row) => row.mock)).toBe(true);
  });
});
