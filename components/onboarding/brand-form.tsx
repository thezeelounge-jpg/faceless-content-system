"use client";

// The onboarding form for a brand. Reusable: admin "New client" uses it now,
// and the customer onboarding (Phase 6) will use it with its own Server Action.
import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AUTOPILOT_LEVELS,
  COUNTRIES,
  LANGUAGES,
  NICHE_PRESETS,
  SOUND_QUESTIONS,
  WEEKDAYS,
  type BrandFormDefaults,
  type BrandFormState,
} from "@/lib/brand-input";

type Action = (prev: BrandFormState, formData: FormData) => Promise<BrandFormState>;

const initialState: BrandFormState = { status: "idle", message: "" };
const selectClass =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm";

export function BrandForm({
  action,
  submitLabel,
  defaults = {},
}: {
  action: Action;
  submitLabel: string;
  defaults?: BrandFormDefaults;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  // After an error, refill the form with what was typed (React clears it on submit).
  return (
    <BrandFields
      key={state.attempt ?? 0}
      defaults={state.values ?? defaults}
      state={state}
      formAction={formAction}
      pending={pending}
      submitLabel={submitLabel}
    />
  );
}

function BrandFields({
  defaults,
  state,
  formAction,
  pending,
  submitLabel,
}: {
  defaults: BrandFormDefaults;
  state: BrandFormState;
  formAction: (formData: FormData) => void;
  pending: boolean;
  submitLabel: string;
}) {
  const errors = state.fieldErrors ?? {};
  const samples = defaults.samples ?? [];
  const days = defaults.posting_days ?? [1, 3, 5];
  const countries = defaults.audience_countries ?? ["PK"];

  return (
    <form action={formAction} className="max-w-xl space-y-6" noValidate>
      <Section title="About the brand">
        <Field id="name" label="Brand or person name" errors={errors.name}>
          <Input id="name" name="name" defaultValue={defaults.name} required maxLength={80} />
        </Field>
        <Field id="niche" label="Niche" errors={errors.niche}>
          <select id="niche" name="niche" defaultValue={defaults.niche ?? ""} required className={selectClass}>
            <option value="" disabled>
              Pick one
            </option>
            {NICHE_PRESETS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="audience" label="Who is it for?" errors={errors.audience}>
          <Textarea id="audience" name="audience" defaultValue={defaults.audience} rows={2} required />
        </Field>
        <Field id="offers" label="What do they sell? (offers and prices)" errors={errors.offers}>
          <Textarea id="offers" name="offers" defaultValue={defaults.offers} rows={2} required />
        </Field>
        <Field id="tone" label="Tone (for example: warm, direct, funny)" errors={errors.tone}>
          <Input id="tone" name="tone" defaultValue={defaults.tone} required />
        </Field>
      </Section>

      <Section title="How do you sound?">
        {SOUND_QUESTIONS.map((q) => (
          <Field key={q.key} id={`sound_${q.key}`} label={q.question} errors={errors[`sound_answers.${q.key}`]}>
            <Input
              id={`sound_${q.key}`}
              name={`sound_${q.key}`}
              defaultValue={defaults.sound_answers?.[q.key]}
              required
            />
          </Field>
        ))}
      </Section>

      <Section title="Writing samples" hint="3 to 5 things they wrote themselves: posts, captions, emails.">
        {[1, 2, 3, 4, 5].map((n) => (
          <Field key={n} id={`sample_${n}`} label={`Sample ${n}${n > 3 ? " (optional)" : ""}`}>
            <Textarea id={`sample_${n}`} name={`sample_${n}`} defaultValue={samples[n - 1]} rows={3} />
          </Field>
        ))}
        <Errors errors={errors.samples} />
      </Section>

      <Section title="Words and language">
        <Field id="banned_words" label="Words to never use (comma or new line between them)" errors={errors.banned_words}>
          <Textarea
            id="banned_words"
            name="banned_words"
            defaultValue={defaults.banned_words?.join(", ")}
            rows={2}
          />
        </Field>
        <Field id="language" label="Language" errors={errors.language}>
          <select id="language" name="language" defaultValue={defaults.language ?? "en"} className={selectClass}>
            {LANGUAGES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Posting">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Posting days</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((day) => (
              <CheckPill key={day.value} name="posting_days" value={String(day.value)} defaultChecked={days.includes(day.value)}>
                {day.label}
              </CheckPill>
            ))}
          </div>
          <Errors errors={errors.posting_days} />
        </fieldset>
        <Field id="posts_per_week" label="Posts per week (1 to 14)" errors={errors.posts_per_week}>
          <Input
            id="posts_per_week"
            name="posts_per_week"
            type="number"
            inputMode="numeric"
            min={1}
            max={14}
            defaultValue={defaults.posts_per_week ?? 3}
            className="w-24"
          />
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Audience countries (up to 3)</legend>
          <div className="flex flex-wrap gap-2">
            {COUNTRIES.map((country) => (
              <CheckPill
                key={country.value}
                name="audience_countries"
                value={country.value}
                defaultChecked={countries.includes(country.value)}
              >
                {country.label}
              </CheckPill>
            ))}
          </div>
          <Errors errors={errors.audience_countries} />
        </fieldset>
      </Section>

      <Section title="Autopilot">
        <fieldset className="space-y-2">
          <legend className="sr-only">Autopilot level</legend>
          {AUTOPILOT_LEVELS.map((level) => (
            <label key={level.value} className="border-input flex items-start gap-3 rounded-lg border p-3 text-sm">
              <input
                type="radio"
                name="autopilot_level"
                value={level.value}
                defaultChecked={(defaults.autopilot_level ?? "review_everything") === level.value}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{level.label}</span>
                <span className="text-muted-foreground block">{level.about}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </Section>

      {state.status === "error" && (
        <p role="alert" className="text-destructive text-sm">
          {state.message}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ id, label, errors, children }: { id: string; label: string; errors?: string[]; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      <Errors errors={errors} />
    </div>
  );
}

function Errors({ errors }: { errors?: string[] }) {
  if (!errors?.length) return null;
  return <p className="text-destructive text-sm">{errors[0]}</p>;
}

function CheckPill({
  name,
  value,
  defaultChecked,
  children,
}: {
  name: string;
  value: string;
  defaultChecked: boolean;
  children: ReactNode;
}) {
  return (
    <label className="border-input has-checked:bg-primary has-checked:text-primary-foreground flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-sm">
      <input type="checkbox" name={name} value={value} defaultChecked={defaultChecked} className="sr-only" />
      {children}
    </label>
  );
}
