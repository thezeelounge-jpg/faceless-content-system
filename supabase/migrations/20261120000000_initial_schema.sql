-- Creator Tool: initial database (Phase 1)
-- Source of truth: docs/PRODUCT.md "Data model".
--
-- Security model (simple on purpose):
--   * Row Level Security is ON for every table.
--   * Signed-in customers can only READ their own rows.
--   * Customers cannot insert, update or delete anything directly.
--     All writes go through our server code (secret key) after permission checks.
--   * Internal tables (QA reports, webhooks, costs, settings) are server-only.
--   * Allowed values use CHECK constraints (easy to change later).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  role text not null default 'customer' check (role in ('admin', 'customer')),
  plan text check (plan in ('creator', 'pro', 'agency')),
  plan_status text not null default 'none'
    check (plan_status in ('none', 'trial', 'active', 'past_due', 'cancelled', 'expired')),
  period_start timestamptz,
  period_end timestamptz,
  trial_used boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.brands (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  niche text,
  audience text,
  offers text,
  tone text,
  sound_answers jsonb not null default '{}'::jsonb,
  samples text,
  banned_words text[] not null default '{}',
  language text not null default 'en' check (language in ('en', 'roman_urdu', 'hinglish')),
  pillars jsonb not null default '[]'::jsonb,
  -- 0 = Sunday ... 6 = Saturday
  posting_days int[] not null default '{1,3,5}' check (posting_days <@ array[0, 1, 2, 3, 4, 5, 6]),
  posts_per_week int not null default 3 check (posts_per_week between 1 and 14),
  audience_countries text[] not null default '{PK}'
    check (cardinality(audience_countries) between 1 and 3),
  posting_times_override jsonb,
  autopilot_level text not null default 'review_everything'
    check (autopilot_level in ('review_everything', 'review_videos', 'full_autopilot')),
  engine text,
  words_per_second numeric(4, 2) not null default 2.4 check (words_per_second > 0),
  is_managed boolean not null default false,
  paused boolean not null default false,
  profile_md text,
  current_version int not null default 0,
  created_at timestamptz not null default now()
);

create table public.brand_versions (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands (id) on delete cascade,
  version int not null,
  profile_md text,
  pillars jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (brand_id, version)
);

create table public.pronunciations (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands (id) on delete cascade,
  written text not null,
  say_as text not null,
  status text not null default 'suggested' check (status in ('suggested', 'approved')),
  source text not null default 'manual' check (source in ('manual', 'qa')),
  created_at timestamptz not null default now()
);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands (id) on delete cascade,
  person_legal_name text not null,
  checkbox_at timestamptz not null,
  words text[] not null,
  words_expire_at timestamptz not null,
  clip_path text,
  clip_checks jsonb,
  admin_status text not null default 'pending' check (admin_status in ('pending', 'approved', 'rejected')),
  admin_note text,
  heygen_consent_status text,
  heygen_consent_url text,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create table public.avatars (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands (id) on delete cascade,
  consent_id uuid references public.consents (id) on delete set null,
  heygen_group_id text,
  heygen_look_id text,
  voice_id text,
  supported_engines text[] not null default '{}',
  chosen_engine text,
  likeness_test jsonb,
  status text not null default 'training'
    check (status in ('training', 'consent_pending', 'likeness_test', 'ready', 'reshoot_needed', 'failed')),
  created_at timestamptz not null default now()
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands (id) on delete cascade,
  scheduled_for timestamptz not null,
  pillar text,
  title text not null,
  hook text,
  format text not null default 'talking' check (format in ('talking', 'story')),
  status text not null default 'planned'
    check (status in ('planned', 'scripting', 'script_review', 'approved', 'rendering', 'audio_qa',
                      'editing', 'final_qa', 'team_review', 'needs_you', 'ready', 'posted',
                      'skipped', 'problem')),
  status_reason text,
  created_at timestamptz not null default now()
);

create table public.scripts (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  version int not null default 1,
  display_text text,
  spoken_text text,
  hook text,
  body text,
  cta text,
  est_seconds numeric(6, 2),
  captions jsonb not null default '{}'::jsonb,
  hashtags text[] not null default '{}',
  broll_keywords text[] not null default '{}',
  edit_plan jsonb not null default '{}'::jsonb,
  qa_status text not null default 'pending' check (qa_status in ('pending', 'passed', 'failed', 'team_review')),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (post_id, version)
);

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands (id) on delete cascade,
  script_id uuid references public.scripts (id) on delete set null,
  avatar_id uuid references public.avatars (id) on delete set null,
  engine text,
  attempt int not null default 1 check (attempt >= 1),
  heygen_video_id text unique,
  status text not null default 'queued'
    check (status in ('queued', 'rendering', 'audio_qa', 'editing', 'final_qa', 'team_review',
                      'needs_you', 'ready', 'failed', 'skipped')),
  raw_path text,
  transcript jsonb,
  final_path text,
  duration_s numeric(6, 2),
  counts_toward_plan boolean not null default false,
  ai_label boolean not null default true,
  watermark boolean not null default false,
  error text,
  created_at timestamptz not null default now()
);

create table public.qa_reports (
  id uuid primary key default gen_random_uuid(),
  video_id uuid references public.videos (id) on delete cascade,
  script_id uuid references public.scripts (id) on delete cascade,
  gate text not null
    check (gate in ('script', 'pronunciation_prep', 'audio', 'technical', 'visual', 'human', 'customer')),
  passed boolean not null,
  score numeric,
  issues jsonb not null default '[]'::jsonb,
  auto_fix text,
  created_at timestamptz not null default now(),
  check (video_id is not null or script_id is not null)
);

create table public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  period_start timestamptz not null,
  delta int not null,
  reason text not null check (reason in ('reserve', 'confirm', 'release', 'admin')),
  video_id uuid references public.videos (id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null check (provider in ('lemonsqueezy', 'manual')),
  external_id text,
  plan text not null check (plan in ('creator', 'pro', 'agency')),
  status text not null,
  renews_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, external_id)
);

create table public.manual_payments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  method text not null check (method in ('bank', 'jazzcash', 'easypaisa', 'other')),
  reference text not null,
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null default 'PKR',
  plan text not null check (plan in ('creator', 'pro', 'agency')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  marked_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (period_end > period_start)
);

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('heygen', 'lemonsqueezy')),
  event_key text not null unique,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid references public.brands (id) on delete set null,
  task text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(10, 4) not null default 0,
  created_at timestamptz not null default now()
);

create table public.provider_usage (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('heygen', 'stt', 'other')),
  video_id uuid references public.videos (id) on delete set null,
  seconds numeric(10, 2) not null default 0,
  cost_usd numeric(10, 4) not null default 0,
  created_at timestamptz not null default now()
);

create table public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value) values
  ('renders_paused', 'false'::jsonb),
  ('daily_spend_cap_usd', '{"heygen": 20, "claude": 5, "stt": 2}'::jsonb),
  ('ramadan', '{"start": null, "end": null}'::jsonb);

-- ---------------------------------------------------------------------------
-- Indexes (foreign keys and common lookups)
-- ---------------------------------------------------------------------------

create index brands_owner_id_idx on public.brands (owner_id);
create index brand_versions_brand_id_idx on public.brand_versions (brand_id);
create unique index pronunciations_brand_written_idx on public.pronunciations (brand_id, lower(written));
create index consents_brand_id_idx on public.consents (brand_id);
create index avatars_brand_id_idx on public.avatars (brand_id);
create index posts_brand_scheduled_idx on public.posts (brand_id, scheduled_for);
create index posts_status_idx on public.posts (status);
create index scripts_post_id_idx on public.scripts (post_id);
create index videos_brand_id_idx on public.videos (brand_id);
create index videos_script_id_idx on public.videos (script_id);
create index videos_status_idx on public.videos (status);
create index qa_reports_video_id_idx on public.qa_reports (video_id);
create index qa_reports_script_id_idx on public.qa_reports (script_id);
create index usage_ledger_owner_period_idx on public.usage_ledger (owner_id, period_start);
create index subscriptions_owner_id_idx on public.subscriptions (owner_id);
create index manual_payments_owner_id_idx on public.manual_payments (owner_id);
create index ai_usage_brand_created_idx on public.ai_usage (brand_id, created_at);
create index provider_usage_video_id_idx on public.provider_usage (video_id);

-- ---------------------------------------------------------------------------
-- New sign-ups get a profile row automatically
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helper: does the signed-in user own this brand?
-- ---------------------------------------------------------------------------

create or replace function public.owns_brand(target_brand_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.brands b
    where b.id = target_brand_id
      and b.owner_id = (select auth.uid())
  );
$$;

revoke execute on function public.owns_brand(uuid) from public, anon;
grant execute on function public.owns_brand(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.brands enable row level security;
alter table public.brand_versions enable row level security;
alter table public.pronunciations enable row level security;
alter table public.consents enable row level security;
alter table public.avatars enable row level security;
alter table public.posts enable row level security;
alter table public.scripts enable row level security;
alter table public.videos enable row level security;
alter table public.qa_reports enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.subscriptions enable row level security;
alter table public.manual_payments enable row level security;
alter table public.webhook_events enable row level security;
alter table public.ai_usage enable row level security;
alter table public.provider_usage enable row level security;
alter table public.app_settings enable row level security;

-- Customers read their own rows.
create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

create policy "brands: read own" on public.brands
  for select to authenticated using (owner_id = (select auth.uid()));

create policy "brand_versions: read own" on public.brand_versions
  for select to authenticated using (public.owns_brand(brand_id));

create policy "pronunciations: read own" on public.pronunciations
  for select to authenticated using (public.owns_brand(brand_id));

create policy "consents: read own" on public.consents
  for select to authenticated using (public.owns_brand(brand_id));

create policy "avatars: read own" on public.avatars
  for select to authenticated using (public.owns_brand(brand_id));

create policy "posts: read own" on public.posts
  for select to authenticated using (public.owns_brand(brand_id));

create policy "scripts: read own" on public.scripts
  for select to authenticated using (
    exists (select 1 from public.posts p where p.id = post_id and public.owns_brand(p.brand_id))
  );

create policy "videos: read own" on public.videos
  for select to authenticated using (public.owns_brand(brand_id));

create policy "usage_ledger: read own" on public.usage_ledger
  for select to authenticated using (owner_id = (select auth.uid()));

create policy "subscriptions: read own" on public.subscriptions
  for select to authenticated using (owner_id = (select auth.uid()));

create policy "manual_payments: read own" on public.manual_payments
  for select to authenticated using (owner_id = (select auth.uid()));

-- qa_reports, webhook_events, ai_usage, provider_usage, app_settings:
-- no policies on purpose, so only server code (secret key) can use them.

-- ---------------------------------------------------------------------------
-- Table privileges (explicit, so they don't depend on project defaults)
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;

grant select on
  public.profiles, public.brands, public.brand_versions, public.pronunciations,
  public.consents, public.avatars, public.posts, public.scripts, public.videos,
  public.usage_ledger, public.subscriptions, public.manual_payments
to authenticated;

grant all on all tables in schema public to service_role;
