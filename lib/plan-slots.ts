// Plan slots (customer usage): STUBS until Phase 7.
// CLAUDE.md "Plan and usage rules": reserve a slot when the render starts,
// confirm it on delivery, release it on failure. In Phase 7 these become
// Postgres functions on usage_ledger called via rpc with row locks.
// Likeness tests and our own re-renders never call these (they never count).

type SlotVideo = { id: string; brand_id: string };

/** TODO Phase 7: usage_ledger 'reserve' (rpc, row lock). No-op for now. */
export async function reservePlanSlot(video: SlotVideo): Promise<void> {
  void video;
}

/** TODO Phase 7: usage_ledger 'confirm' when the customer gets the video. No-op for now. */
export async function confirmPlanSlot(video: SlotVideo): Promise<void> {
  void video;
}

/** TODO Phase 7: usage_ledger 'release' when the render fails. No-op for now. */
export async function releasePlanSlot(video: SlotVideo): Promise<void> {
  void video;
}
