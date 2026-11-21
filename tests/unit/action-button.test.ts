import { describe, expect, it } from "vitest";
import { actionButtonView } from "@/components/admin/action-button-view";

// The pure part of components/admin/action-button.tsx: what the button shows
// while its Server Action runs (pending comes from useActionState).
describe("action button pending state", () => {
  it("idle: the normal label, clickable", () => {
    expect(actionButtonView(false, "Write script", "Writing…")).toEqual({ text: "Write script", disabled: false, busy: false });
  });

  it("pending: the pending label, disabled (no double clicks) and marked busy", () => {
    expect(actionButtonView(true, "Run checks", "Checking…")).toEqual({ text: "Checking…", disabled: true, busy: true });
  });
});
