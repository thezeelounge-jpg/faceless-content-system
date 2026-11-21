"use client";

import { createClient } from "@supabase/supabase-js";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { validateUpload } from "@/lib/consent-upload-rules";
import type { ActionState } from "@/lib/plain-error";

// Record in the browser (MediaRecorder) or pick a file, then:
// 1. ask the server for a one-time signed upload (it checks type and size),
// 2. upload straight into the PRIVATE consent-clips bucket,
// 3. tell the server, which checks the stored file and runs the clip checks.
// The browser never gets a key that can read the bucket.

type Ticket = { ok: true; path: string; token: string } | { ok: false; message: string };

const BUCKET = "consent-clips";

function pickMimeType(): string {
  for (const type of ["video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export function ConsentUpload({
  consentId,
  supabaseUrl,
  supabaseKey,
  prepare,
  confirm,
}: {
  consentId: string;
  supabaseUrl: string;
  supabaseKey: string;
  prepare: (consentId: string, file: { name: string; type: string; size: number }) => Promise<Ticket>;
  confirm: (consentId: string, path: string) => Promise<ActionState>;
}) {
  const [message, setMessage] = useState<ActionState>({ status: "idle", message: "" });
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const preview = useRef<HTMLVideoElement | null>(null);

  async function upload(file: File) {
    setBusy(true);
    try {
      const details = { name: file.name, type: file.type.split(";")[0], size: file.size };
      // Decision 4: same type/size check as the server, before any upload starts.
      const problem = validateUpload(details);
      if (problem) return setMessage({ status: "error", message: problem });
      setMessage({ status: "idle", message: "Checking the file…" });
      const ticket = await prepare(consentId, details);
      if (!ticket.ok) return setMessage({ status: "error", message: ticket.message });
      setMessage({ status: "idle", message: "Uploading… (keep this page open)" });
      const storage = createClient(supabaseUrl, supabaseKey).storage.from(BUCKET);
      const { error } = await storage.uploadToSignedUrl(ticket.path, ticket.token, file, {
        contentType: file.type.split(";")[0],
      });
      if (error) return setMessage({ status: "error", message: "The upload failed. Check your connection and try again." });
      setMessage({ status: "idle", message: "Uploaded. Starting the clip checks…" });
      setMessage(await confirm(consentId, ticket.path));
    } catch {
      setMessage({ status: "error", message: "Something went wrong. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (preview.current) {
        preview.current.srcObject = stream;
        await preview.current.play();
      }
      const mimeType = pickMimeType();
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : undefined);
      rec.ondataavailable = (event) => event.data.size > 0 && chunks.push(event.data);
      rec.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const type = (rec.mimeType || "video/webm").split(";")[0];
        const file = new File(chunks, `recording.${type === "video/mp4" ? "mp4" : "webm"}`, { type });
        void upload(file);
      };
      recorder.current = rec;
      rec.start(1000);
      setRecording(true);
    } catch {
      setMessage({ status: "error", message: "We couldn't open the camera. Allow camera and microphone, or upload a file." });
    }
  }

  function stopRecording() {
    recorder.current?.stop();
    setRecording(false);
  }

  return (
    <div className="space-y-3">
      <video ref={preview} muted playsInline className="bg-muted aspect-[9/16] w-full max-w-[240px] rounded" />
      <div className="flex flex-wrap gap-2">
        {recording ? (
          <Button type="button" onClick={stopRecording}>
            Stop and upload
          </Button>
        ) : (
          <Button type="button" onClick={startRecording} disabled={busy}>
            Record in the browser
          </Button>
        )}
        <label className="inline-flex cursor-pointer items-center rounded border px-3 py-2 text-sm">
          Upload a file (MP4, WebM or MOV, up to 50 MB)
          <input
            type="file"
            accept="video/mp4,video/webm,video/quicktime,.mov"
            className="sr-only"
            disabled={busy || recording}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
      </div>
      {message.message && (
        <p role={message.status === "error" ? "alert" : "status"} className={message.status === "error" ? "text-destructive text-sm" : "text-sm"}>
          {message.message}
        </p>
      )}
    </div>
  );
}
