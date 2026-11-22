import { describe, expect, it, vi } from "vitest";
import { createEditFiles, createRunFileStorage, type EditBucket } from "@/lib/edit-store";
import { EDIT } from "@/lib/qa/config";

// p4-b1 (QA SF4): the edit task's storage download / upload have a per-attempt
// timeout (abort), at most EDIT.storage_max_attempts tries with backoff + jitter,
// and retry only errors that can pass (timeouts, network, 5xx, 408, 429).
// Fake buckets only: no Supabase, no network.

const RAW = "raw/b/v.mp4";
const FINAL = "final/b/v.mp4";
const blob = (text: string) => new Blob([text]);
const ok = <T>(data: T) => ({ data, error: null });
const err = (status: number | undefined, message = "storage error") => ({ data: null, error: { message, status } });

function fakeBucket(over: Partial<EditBucket>): EditBucket {
  return {
    download: async () => ok(blob("raw")),
    upload: async () => ok({ path: FINAL }),
    remove: async () => ok([]),
    ...over,
  };
}

const fast = () => ({ sleep: vi.fn(async (_ms: number) => {}), random: () => 0.5, timeoutMs: 30 });

describe("p5-a cleanup storage (list + remove, same timeout + retry)", () => {
  it("lists a folder (age from updated_at, else created_at), retries a 503, removes one path", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(err(503))
      .mockResolvedValueOnce(
        ok([
          { name: "run_a.mp4", updated_at: "2026-11-22T00:00:00Z" },
          { name: "run_b.mp4", updated_at: null, created_at: "2026-11-21T00:00:00Z" },
          { name: "odd" },
        ]),
      );
    const remove = vi.fn(async (_paths: string[]) => ok([]));
    const storage = createRunFileStorage({ list, remove }, fast());
    expect(await storage.list("final/b/v/runs")).toEqual([
      { name: "run_a.mp4", updated_at: "2026-11-22T00:00:00Z" },
      { name: "run_b.mp4", updated_at: "2026-11-21T00:00:00Z" },
      { name: "odd", updated_at: null },
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledWith("final/b/v/runs", { limit: 1000 });
    await storage.remove("final/b/v/runs/run_a.mp4");
    expect(remove).toHaveBeenCalledWith(["final/b/v/runs/run_a.mp4"]);
  });
});

describe("edit storage: timeout + bounded retry", () => {
  it("a hung download times out (the signal is aborted) and is retried, then gives up after the attempt limit", async () => {
    const signals: AbortSignal[] = [];
    const download = vi.fn((_path: string, _o?: undefined, params?: { signal?: AbortSignal }) => {
      signals.push(params?.signal as AbortSignal);
      // Hangs far past the 30 ms timeout (answers only after 300 ms, as a stuck connection would).
      return new Promise<ReturnType<typeof ok<Blob>>>((resolve) => setTimeout(() => resolve(ok(blob("late"))), 300));
    });
    const opts = fast();
    const files = createEditFiles(fakeBucket({ download }), opts);
    await expect(files.download(RAW)).rejects.toThrow(/timed out/);
    expect(download).toHaveBeenCalledTimes(EDIT.storage_max_attempts);
    expect(signals.every((s) => s?.aborted === true)).toBe(true);
  });

  it("two failures (503, then a network error) then success: returns the bytes after 3 tries, with growing backoff + jitter", async () => {
    const download = vi
      .fn()
      .mockResolvedValueOnce(err(503))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok(blob("raw bytes")));
    const opts = fast();
    const files = createEditFiles(fakeBucket({ download }), opts);
    const bytes = await files.download(RAW);
    expect(Buffer.from(bytes).toString()).toBe("raw bytes");
    expect(download).toHaveBeenCalledTimes(3);
    const waits = opts.sleep.mock.calls.map(([ms]) => ms);
    // backoff * 2^(try-1) + jitter (random 0.5 → half a backoff)
    expect(waits).toEqual([EDIT.storage_backoff_ms * 1.5, EDIT.storage_backoff_ms * 2.5]);
  });

  it("a non-retryable answer (404 not found, 403) is not retried", async () => {
    for (const status of [404, 403, 400]) {
      const download = vi.fn().mockResolvedValue(err(status, "Object not found"));
      const opts = fast();
      const files = createEditFiles(fakeBucket({ download }), opts);
      await expect(files.download(RAW)).rejects.toThrow(/download raw video/);
      expect(download).toHaveBeenCalledTimes(1);
      expect(opts.sleep).not.toHaveBeenCalled();
    }
  });

  it("an upload that keeps failing (500) gives up after exactly the attempt limit", async () => {
    const upload = vi.fn().mockResolvedValue(err(500));
    const opts = fast();
    const files = createEditFiles(fakeBucket({ upload }), opts);
    await expect(files.upload(FINAL, new Uint8Array([1]), "video/mp4")).rejects.toThrow(/upload final video/);
    expect(upload).toHaveBeenCalledTimes(3);
    expect(EDIT.storage_max_attempts).toBe(3);
  });

  it("a slow upload past the timeout counts as a timeout; 429 is retried", async () => {
    const upload = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(ok({})), 500)))
      .mockResolvedValueOnce(err(429))
      .mockResolvedValueOnce(ok({ path: FINAL }));
    const files = createEditFiles(fakeBucket({ upload }), fast());
    await expect(files.upload(FINAL, new Uint8Array([1]), "video/mp4")).resolves.toBeUndefined();
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it("the worst case (download + upload, every try timing out) still fits inside the task's maxDuration with ffmpeg", () => {
    const backoff = EDIT.storage_backoff_ms * (1 + 2) * 2; // two waits, jitter at most one backoff each
    const oneCall = EDIT.storage_max_attempts * EDIT.storage_timeout_s * 1000 + backoff;
    // p4-b2: plus ffprobe (video length) and the loudness pass 1 (audio only), each with its own limit.
    const tools = EDIT.ffmpeg_timeout_s + EDIT.loudness_timeout_s + EDIT.probe_timeout_s;
    expect(EDIT.loudness_timeout_s).toBeGreaterThan(0);
    expect(EDIT.probe_timeout_s).toBeGreaterThan(0);
    expect(2 * oneCall + tools * 1000).toBeLessThan(EDIT.task_max_duration_s * 1000);
  });
});
