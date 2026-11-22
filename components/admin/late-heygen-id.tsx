// p4-b1 (Rowan 5b): a small read-only line on the admin video page. When
// HeyGen finished an older render of this video after we had moved on (a
// newer render was kept), adopt_late_render saved HeyGen's id in
// videos.late_heygen_video_id. Admins see it here so they can find that video
// on the HeyGen dashboard. Admin pages only (never shown to customers).

export const LATE_HEYGEN_ID_LABEL = "Late HeyGen video";

export function LateHeygenIdLine({ lateHeygenVideoId }: { lateHeygenVideoId: string | null | undefined }) {
  const id = lateHeygenVideoId?.trim();
  if (!id) return null;
  return (
    <p className="text-sm">
      <span className="font-medium">{LATE_HEYGEN_ID_LABEL}:</span> <code className="break-all">{id}</code>
      <span className="text-muted-foreground">
        {" "}
        — HeyGen finished an older render of this video late. A newer render was kept; this id is only saved so you can find it on
        the HeyGen dashboard.
      </span>
    </p>
  );
}
