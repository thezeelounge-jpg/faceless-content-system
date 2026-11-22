-- p4-b3 (Q8): at most one ACTIVE post video per POST (was: per script).
--
-- Why: a post CAN have two live scripts. Two overlapping "Run checks" runs
-- (or Write script's own checks plus a Run checks click) both pass
-- canRunChecks (lib/qa/can-run-checks.ts). One passes v1 and the post becomes
-- 'approved'; the other is still rewriting and then inserts v2
-- (lib/qa/script-pipeline.ts runGate1 → store.insertScriptVersion, which has
-- no post-status guard). Make video for v1 leaves the post 'approved' while
-- the video is queued, so Make video for v2 also passed, and the per-script
-- index (20261122150000) did not see two DIFFERENT scripts = two paid renders.
--
-- Now:
-- (a) videos.post_id, filled from the script by a trigger on every insert and
--     on every change of script_id/kind (so no insert path can forget it);
--     likeness tests have none. Backfilled below. Server only (no customer
--     grant: see 20261122100000, new columns stay server only).
-- (b) The unique partial index is per post: kind = 'post', status not in
--     ('failed', 'skipped'). It replaces videos_one_active_post_video.
-- (c) create_post_render keeps the same per-post advisory lock and checks for
--     an active video of ANY script of the post: same script → 'existing',
--     another script → 'other_script' (the app shows a plain refusal; it never
--     hands back a video that says the old words).
--
-- Could this fail on existing data? Only if some post already has two active
-- post videos. Then this migration stops with a clear error and changes
-- nothing (one transaction). Check first with:
--   select s.post_id, count(*) from public.videos v join public.scripts s on s.id = v.script_id
--   where v.kind = 'post' and v.status not in ('failed', 'skipped')
--   group by s.post_id having count(*) > 1;
-- We do NOT auto-fix duplicates: either row may be a paid render.

do $$
begin
  if exists (
    select 1 from public.videos v join public.scripts s on s.id = v.script_id
    where v.kind = 'post' and v.status not in ('failed', 'skipped')
    group by s.post_id having count(*) > 1
  ) then
    raise exception 'p4-b3: some posts already have two active post videos. Fix them by hand (see the query at the top of this migration) before pushing.';
  end if;
end;
$$;

alter table public.videos add column post_id uuid references public.posts (id) on delete set null;
comment on column public.videos.post_id is 'The post of a post video (from its script, kept by trigger videos_fill_post_id). Null for likeness tests.';
create index videos_post_id_idx on public.videos (post_id);

update public.videos v
set post_id = s.post_id
from public.scripts s
where s.id = v.script_id and v.kind = 'post';

create or replace function public.videos_fill_post_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'post' and new.script_id is not null then
    select s.post_id into new.post_id from public.scripts s where s.id = new.script_id;
  elsif new.kind <> 'post' then
    new.post_id := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.videos_fill_post_id() from public, anon, authenticated;

create trigger videos_fill_post_id
  before insert or update of script_id, kind on public.videos
  for each row execute function public.videos_fill_post_id();

drop index public.videos_one_active_post_video;
create unique index videos_one_active_post_video_per_post on public.videos (post_id)
  where kind = 'post' and post_id is not null and status not in ('failed', 'skipped');

create or replace function public.create_post_render(
  p_post_id uuid, p_script_id uuid, p_brand_id uuid, p_avatar_id uuid, p_engine text, p_spoken_words int)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_latest uuid;
  v_existing uuid;
  v_existing_script uuid;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('post_render'), hashtext(p_post_id::text));

  select status into v_status from public.posts where id = p_post_id and brand_id = p_brand_id;
  select id into v_latest from public.scripts where post_id = p_post_id order by version desc, created_at desc limit 1;
  if v_status is distinct from 'approved' or v_latest is distinct from p_script_id then
    return jsonb_build_object('outcome', 'not_approved', 'video_id', null);
  end if;

  -- p4-b3: any active post video of THIS POST (any script), not only of this script.
  select id, script_id into v_existing, v_existing_script from public.videos
  where post_id = p_post_id and kind = 'post' and status not in ('failed', 'skipped')
  order by created_at desc limit 1;
  if v_existing is not null then
    return jsonb_build_object(
      'outcome', case when v_existing_script = p_script_id then 'existing' else 'other_script' end,
      'video_id', v_existing);
  end if;

  insert into public.videos (brand_id, post_id, script_id, avatar_id, kind, engine, spoken_words)
  values (p_brand_id, p_post_id, p_script_id, p_avatar_id, 'post', p_engine, p_spoken_words)
  returning id into v_id;
  return jsonb_build_object('outcome', 'created', 'video_id', v_id);
end;
$$;

revoke execute on function public.create_post_render(uuid, uuid, uuid, uuid, text, int) from public, anon, authenticated;
grant execute on function public.create_post_render(uuid, uuid, uuid, uuid, text, int) to service_role;
