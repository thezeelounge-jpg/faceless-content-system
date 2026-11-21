-- Phase 3 part B, step 1: the HeyGen spend guard (lib/heygen-spend.ts).
--
-- Every HeyGen call that can cost money (create twin now, render in step 2)
-- reserves a provider_usage row BEFORE the call, and is refused when
-- renders_paused is on or today's cap (Asia/Karachi day) is reached.
-- provider_usage stays server only (RLS on, no policies, no grants to anon or
-- authenticated: see the initial schema). This is provider spend; customer
-- plan slots stay in usage_ledger.

alter table public.provider_usage
  add column kind text not null default 'other' check (kind in ('create_twin', 'render', 'other')),
  add column avatar_id uuid references public.avatars (id) on delete set null,
  add column status text not null default 'succeeded' check (status in ('reserved', 'succeeded', 'failed')),
  add column note text;

create index provider_usage_kind_created_idx on public.provider_usage (provider, kind, created_at);
create index provider_usage_avatar_id_idx on public.provider_usage (avatar_id);

-- Safe default caps (same numbers as HEYGEN_DAILY_CAP_DEFAULTS in lib/config.ts).
insert into public.app_settings (key, value)
values ('heygen_daily_caps', '{"render": 3, "create_twin": 2}'::jsonb)
on conflict (key) do nothing;

-- Atomic "check the cap and reserve": an advisory lock per kind makes two
-- runs at the same moment wait for each other, so they can't both slip under
-- the cap. Every row counts (failed ones too: a failed call may have cost).
-- p_since is the start of today in Asia/Karachi, computed by the app.
create or replace function public.reserve_heygen_spend(
  p_kind text,
  p_since timestamptz,
  p_cap int,
  p_avatar_id uuid,
  p_video_id uuid,
  p_note text
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  used int;
  new_id uuid;
begin
  if p_kind not in ('create_twin', 'render') then
    raise exception 'unknown spend kind %', p_kind;
  end if;
  perform pg_advisory_xact_lock(hashtext('heygen_spend:' || p_kind));
  select count(*) into used
  from public.provider_usage
  where provider = 'heygen' and kind = p_kind and created_at >= p_since;
  if used >= p_cap then
    return null;
  end if;
  insert into public.provider_usage (provider, kind, avatar_id, video_id, status, cost_usd, note)
  values ('heygen', p_kind, p_avatar_id, p_video_id, 'reserved', 0, p_note)
  returning id into new_id;
  return new_id;
end;
$$;

revoke execute on function public.reserve_heygen_spend(text, timestamptz, int, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_heygen_spend(text, timestamptz, int, uuid, uuid, text) to service_role;
