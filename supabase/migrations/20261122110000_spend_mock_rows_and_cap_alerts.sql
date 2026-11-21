-- Fix pass p3-fix2: the HeyGen spend guard (lib/heygen-spend.ts).
--
-- Decision (a) (Rowan): MOCK provider_usage rows (no HeyGen call, cost 0) are
-- still recorded but do NOT count toward the daily cap. A dedicated column
-- marks them, because withHeygenSpend overwrites `note` when a call fails.
-- reserve_heygen_spend keeps its signature, its advisory lock per kind and
-- its count + insert in one transaction (race safety unchanged); it now
-- counts only real rows (not mock) and sets mock = (p_note = 'mock').
--
-- SF4 (QA SHOULD FIX 4): when the cap is hit the app sets renders_paused and
-- queues a mocked alert to the admins in email_outbox, once per kind per
-- Karachi day: kind 'spend_cap_alert' and a unique dedupe_key
-- ('spend_cap:<kind>:<day>:<email>'; null for other emails, never collides).
-- email_outbox stays server only (no grants change).

alter table public.provider_usage add column mock boolean not null default false;
update public.provider_usage set mock = true where note = 'mock' and cost_usd = 0;

alter table public.email_outbox add column dedupe_key text;
alter table public.email_outbox add constraint email_outbox_dedupe_key_key unique (dedupe_key);
alter table public.email_outbox drop constraint email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('consent_link', 'reshoot_tips', 'spend_cap_alert'));

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
  is_mock boolean := coalesce(p_note = 'mock', false);
begin
  if p_kind not in ('create_twin', 'render') then
    raise exception 'unknown spend kind %', p_kind;
  end if;
  perform pg_advisory_xact_lock(hashtext('heygen_spend:' || p_kind));
  -- Only REAL rows count. Every call (mock too) is checked against that count,
  -- so in mock mode the cap only bites if real calls already used it up.
  select count(*) into used
  from public.provider_usage
  where provider = 'heygen' and kind = p_kind and created_at >= p_since and not mock;
  if used >= p_cap then
    return null;
  end if;
  insert into public.provider_usage (provider, kind, avatar_id, video_id, status, cost_usd, note, mock)
  values ('heygen', p_kind, p_avatar_id, p_video_id, 'reserved', 0, p_note, is_mock)
  returning id into new_id;
  return new_id;
end;
$$;

-- create or replace keeps the existing grants; restated so this file is complete.
revoke execute on function public.reserve_heygen_spend(text, timestamptz, int, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_heygen_spend(text, timestamptz, int, uuid, uuid, text) to service_role;
