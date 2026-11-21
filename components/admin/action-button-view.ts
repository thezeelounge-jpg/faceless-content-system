// What an ActionButton shows while its Server Action runs. Pure, so it can be
// unit tested; `pending` comes from useActionState in action-button.tsx.
export function actionButtonView(
  pending: boolean,
  label: string,
  pendingLabel: string,
): { text: string; disabled: boolean; busy: boolean } {
  return { text: pending ? pendingLabel : label, disabled: pending, busy: pending };
}
