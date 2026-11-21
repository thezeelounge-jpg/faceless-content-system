-- Phase 3 (the face), part A: consent clips and digital twins.
--
-- 1. email_outbox: emails are NOT sent yet (no Resend in Phase 3). The HeyGen
--    consent link and reshoot tips are stored here instead, so the admin can
--    see what would have been sent. Server only: RLS on, no policies, no grant
--    to anon or authenticated. status can only be 'mocked' for now; Phase 5
--    widens it when real sending arrives.
-- 2. avatars: one twin per consent (unique consent_id, so a repeated approval
--    can never create a second twin), plus an error column for plain HeyGen
--    error messages (every external call saves a clear error on the row).

create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid references public.brands (id) on delete set null,
  consent_id uuid references public.consents (id) on delete set null,
  to_email text not null,
  kind text not null check (kind in ('consent_link', 'reshoot_tips')),
  subject text not null,
  body text not null,
  status text not null default 'mocked' check (status in ('mocked')),
  created_at timestamptz not null default now()
);

create index email_outbox_brand_id_idx on public.email_outbox (brand_id, created_at);
create index email_outbox_consent_id_idx on public.email_outbox (consent_id);

alter table public.email_outbox enable row level security;
-- No policies on purpose: only server code (secret key) can use it.
revoke all on public.email_outbox from anon, authenticated;
grant all on public.email_outbox to service_role;

alter table public.avatars add column error text;
create unique index avatars_consent_id_key on public.avatars (consent_id);
