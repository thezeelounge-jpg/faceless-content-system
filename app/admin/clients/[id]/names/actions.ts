"use server";

import { revalidatePath } from "next/cache";
import { logAdminError, plainAdminMessage } from "@/lib/admin-errors";
import { requireAdmin } from "@/lib/auth";
import { getBrand } from "@/lib/brands";
import type { ActionState } from "@/lib/plain-error";
import { pronunciationInput } from "@/lib/pronunciation/dictionary";
import { addPronunciation, approvePronunciation, updatePronunciation } from "@/lib/pronunciations";

// "How to say names" for one brand. Every action checks admin first.

const NOT_FOUND = { status: "error", message: "Client not found." } as const satisfies ActionState;
const NAME_NOT_FOUND = { status: "error", message: "Name not found." } as const satisfies ActionState;
const SAVE_FAILED = "Couldn't save. Please try again in a minute.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readEntry(formData: FormData) {
  const text = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  };
  return pronunciationInput.safeParse({ written: text("written"), say_as: text("say_as") });
}

const saved = (entry: { written: string; say_as: string }): ActionState => ({
  status: "ok",
  message: `Saved: “${entry.written}” is said “${entry.say_as}”.`,
});

/** Add a name typed by the operator (approved straight away). */
export async function addName(brandId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const parsed = readEntry(formData);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0].message };
  try {
    const brand = await getBrand(brandId);
    if (!brand) return NOT_FOUND;
    await addPronunciation(brand.id, parsed.data);
    revalidatePath(`/admin/clients/${brand.id}/names`);
    return saved(parsed.data);
  } catch (error) {
    logAdminError("[admin] add name failed", { brandId }, error);
    return { status: "error", message: plainAdminMessage(error, SAVE_FAILED) };
  }
}

/** Approve a suggested name, so spoken_text uses it from now on. */
export async function approveName(brandId: string, id: string, _prev: ActionState): Promise<ActionState> {
  await requireAdmin();
  if (!UUID.test(id)) return NAME_NOT_FOUND;
  try {
    const brand = await getBrand(brandId);
    if (!brand) return NOT_FOUND;
    if (!(await approvePronunciation(brand.id, id))) return NAME_NOT_FOUND;
    revalidatePath(`/admin/clients/${brand.id}/names`);
    return { status: "ok", message: "Approved." };
  } catch (error) {
    logAdminError("[admin] approve name failed", { brandId, id }, error);
    return { status: "error", message: plainAdminMessage(error, SAVE_FAILED) };
  }
}

/** Change how a name is written or said. */
export async function editName(brandId: string, id: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  if (!UUID.test(id)) return NAME_NOT_FOUND;
  const parsed = readEntry(formData);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0].message };
  try {
    const brand = await getBrand(brandId);
    if (!brand) return NOT_FOUND;
    if (!(await updatePronunciation(brand.id, id, parsed.data))) return NAME_NOT_FOUND;
    revalidatePath(`/admin/clients/${brand.id}/names`);
    return saved(parsed.data);
  } catch (error) {
    logAdminError("[admin] edit name failed", { brandId, id }, error);
    return { status: "error", message: plainAdminMessage(error, SAVE_FAILED) };
  }
}
