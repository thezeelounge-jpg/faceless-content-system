-- p4-b1 (QA SHOULD FIX 1): "Make video" vs a late HeyGen webhook.
-- The hole (QA race B): Make video found no active video, the webhook then
-- adopted the old (cleared) render V1, and Make video still inserted V2,
-- which could be POSTed to HeyGen = a second paid render.
--
-- Closed in the database, two ways:
-- (a) A unique partial index: at most one ACTIVE post video per script.
--     "Active" = kind = 'post' and status not in ('failed', 'skipped').
--     A cleared claim always sets status 'failed' (clear_stuck_claim), so a
--     retired row is never active; an adopted row is back to 'rendering' and
--     IS active (it is the paid render we keep). Likeness tests (no script)
--     are not covered. Per script, not per post: videos has no post_id
--     column, and an index cannot look at another table. Different scripts
--     of one post are covered by (b) plus the newer-script check below.
-- (b) One transaction-scoped advisory lock per post,
--     pg_advisory_xact_lock(hashtext('post_render'), hashtext(post_id)),
--     taken by create_post_render (the only "Make video" insert path, with
--     the post-is-approved check and the active-video check inside the lock)
--     and by adopt_late_render. Whichever runs second sees what the first
--     committed: adopt first → the post is 'rendering', Make video answers
--     'not_approved'; Make video first → adopt sees the newer row ('moved_on').
--     Two int4 keys = a separate key space from claim_render_slot's
--     single-key lock (Postgres docs, "Advisory Lock Functions").
--
-- Could the index fail on existing data? Only if some script already has two
-- active post videos. The old code checked first, so that needs the race
-- itself; staging has only mock renders. If it does exist, this migration
-- stops with a clear error and changes nothing (whole file is one
-- transaction). Check first with:
--   select script_id, count(*) from public.videos
--   where kind = 'post' and script_id is not null and status not in ('failed', 'skipped')
--   group by script_id having count(*) > 1;
-- We do NOT auto-fix duplicates: either row may be a paid render.
--
-- QA NICE: adopt_late_render also answers 'moved_on' when the post has a
-- newer script (higher version) than the late render's script.
-- Replaces adopt_late_render from 20261122130000 (never edit that file).

do $$
begin
  if exists (
    select 1 from public.videos
    where kind = 'post' and script_id is not null and status not in ('failed', 'skipped')
    group by script_id having count(*) > 1
  ) then
    raise exception 'p4-b1: some scripts already have two active post videos. Fix them by hand (see the query at the top of this migration) before pushing.';
  end if;
end;
$$;

create unique index videos_one_active_post_video on public.videos (script_id)
  where kind = 'post' and script_id is not null and status not in ('failed', 'skipped');

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
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('post_render'), hashtext(p_post_id::text));

  select status into v_status from public.posts where id = p_post_id and brand_id = p_brand_id;
  select id into v_latest from public.scripts where post_id = p_post_id order by version desc, created_at desc limit 1;
  if v_status is distinct from 'approved' or v_latest is distinct from p_script_id then
    return jsonb_build_object('outcome', 'not_approved', 'video_id', null);
  end if;

  select id into v_existing from public.videos
  where script_id = p_script_id and kind = 'post' and status not in ('failed', 'skipped')
  order by created_at desc limit 1;
  if v_existing is not null then
    return jsonb_build_object('outcome', 'existing', 'video_id', v_existing);
  end if;

  insert into public.videos (brand_id, script_id, avatar_id, kind, engine, spoken_words)
  values (p_brand_id, p_script_id, p_avatar_id, 'post', p_engine, p_spoken_words)
  returning id into v_id;
  return jsonb_build_object('outcome', 'created', 'video_id', v_id);
end;
$$;

revoke execute on function public.create_post_render(uuid, uuid, uuid, uuid, text, int) from public, anon, authenticated;
grant execute on function public.create_post_render(uuid, uuid, uuid, uuid, text, int) to service_role;

-- Same as 20261122130000, plus: the per-post lock (taken BEFORE the row lock,
-- the same order as create_post_render, so the two never deadlock) and the
-- newer-script check.
create or replace function public.adopt_late_render(p_video_id uuid, p_heygen_video_id text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v record;
  v_post uuid;
  v_version int;
  newer boolean;
begin
  select s.post_id, s.version into v_post, v_version
  from public.videos o join public.scripts s on s.id = o.script_id
  where o.id = p_video_id and o.kind = 'post';
  if v_post is not null then
    perform pg_advisory_xact_lock(hashtext('post_render'), hashtext(v_post::text));
  end if;

  select id, kind, script_id, avatar_id, engine, status, heygen_video_id, render_started_at, claim_cleared_at into v
  from public.videos where id = p_video_id for update;
  if not found or v.status <> 'failed' or v.heygen_video_id is not null
     or (v.render_started_at is null and v.claim_cleared_at is null) then
    return 'not_late';
  end if;

  if v.kind = 'post' then
    select exists (
      select 1 from public.videos o join public.scripts s on s.id = o.script_id
      where s.post_id = v_post and o.id <> v.id and o.status not in ('failed', 'skipped')
    ) or exists (
      select 1 from public.scripts s where s.post_id = v_post and s.version > v_version
    ) into newer;
  else
    select exists (
      select 1 from public.videos o
      where o.kind = 'likeness_test' and o.avatar_id is not distinct from v.avatar_id
        and o.engine is not distinct from v.engine and o.id <> v.id and o.status not in ('failed', 'skipped')
    ) into newer;
  end if;

  if newer then
    update public.videos
    set late_heygen_video_id = p_heygen_video_id,
        error = 'HeyGen finished this video late, after a newer render or script was started. The newer one was kept; the late HeyGen id is saved.'
    where id = v.id;
    return 'moved_on';
  end if;

  update public.videos
  set heygen_video_id = p_heygen_video_id,
      status = 'rendering',
      error = 'HeyGen finished this video late (after its claim was cleared or the wait ran out). Downloading it now.'
  where id = v.id;
  if v_post is not null then
    update public.posts set status = 'rendering', status_reason = null
    where id = v_post and status in ('approved', 'team_review');
  end if;
  return 'adopted';
end;
$$;

revoke execute on function public.adopt_late_render(uuid, text) from public, anon, authenticated;
grant execute on function public.adopt_late_render(uuid, text) to service_role;
