-- Fix pass p4-fix (Sunny's HARD BLOCKER, QA SHOULD FIX 3): "Clear stuck claim"
-- must not lose a paid file. Replaces clear_stuck_claim (20261122120000) and
-- claim_render_slot (20261122090000), adds adopt_late_render.
--
-- c1. The wait. A claim can be cleared only when it is older than the render
--     wait (RENDER.poll_max_s in lib/qa/config.ts = 1800 s; tests/db/rls.test.ts
--     checks the number below matches) OR the row already failed. Before that,
--     HeyGen may still be making the video: the function answers 'too_soon'
--     and writes nothing. Twins use the same 30 minutes (a lost create answer
--     has no webhook and no poll, so there is no longer twin window to wait for).
-- c2. Retired rows. A cleared video gets claim_cleared_at and is never claimed
--     again (claim_render_slot answers 'taken'); a new render always uses a
--     new row ("Make video" / likeness test already do). So any webhook that
--     later names this row (callback_id) can only be the old, paid render.
--     adopt_late_render handles that late success atomically:
--       - 'adopted': nothing newer exists for the post (or likeness engine):
--         save HeyGen's id, status back to 'rendering' (so the normal webhook /
--         poll download finishes it), post back to 'rendering' if it was
--         'approved' or 'team_review'. No claim is set and no spend row is
--         written: it was paid for already.
--       - 'moved_on': a newer render (any row not failed/skipped) exists: keep
--         it; only record late_heygen_video_id on the old row.
--       - 'not_late': not a failed row that reached HeyGen without an id.
--     It never touches provider_usage.
-- d.  Clearing a POST render claim moves the post back to 'approved' (only from
--     'rendering' or 'team_review'), in the same transaction, so "Make video"
--     works again. Likeness tests have no post.
-- All functions: search_path = '', service_role only.

alter table public.videos add column claim_cleared_at timestamptz;
alter table public.videos add column late_heygen_video_id text;

comment on column public.videos.claim_cleared_at is
  'Set by clear_stuck_claim. A cleared row is retired: claim_render_slot never claims it again.';
comment on column public.videos.late_heygen_video_id is
  'HeyGen id of a render that finished after its claim was cleared, when a newer render was kept.';

create or replace function public.clear_stuck_claim(p_target text, p_id uuid, p_admin_email text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  -- Must equal RENDER.poll_max_s (lib/qa/config.ts); tests/db/rls.test.ts checks it.
  c_wait constant interval := interval '1800 seconds';
  v_kind text;
  v_script uuid;
  v_status text;
  v_started timestamptz;
  v_has_id boolean;
  cleared text;
begin
  if p_target = 'video' then
    select kind, script_id, status, render_started_at, heygen_video_id is not null
      into v_kind, v_script, v_status, v_started, v_has_id
    from public.videos where id = p_id for update;
    if not found or v_started is null or v_has_id then
      return 'none';
    end if;
    if v_status <> 'failed' and v_started > now() - c_wait then
      return 'too_soon';
    end if;
    update public.videos
    set render_started_at = null,
        status = 'failed',
        claim_cleared_at = now(),
        error = 'Claim cleared by an admin after checking HeyGen. Start it again when ready.'
    where id = p_id;
    cleared := case when v_kind = 'likeness_test' then 'likeness_test' else 'render' end;
    -- d: the post can be made again.
    if v_kind = 'post' and v_script is not null then
      update public.posts
      set status = 'approved', status_reason = null
      where id = (select post_id from public.scripts where id = v_script)
        and status in ('rendering', 'team_review');
    end if;
    insert into public.provider_usage (provider, kind, video_id, status, cost_usd, mock, note)
    values ('heygen', 'claim_cleared', p_id, 'succeeded', 0, false,
            cleared || ' claim cleared by ' || coalesce(p_admin_email, 'unknown admin') || ' after checking HeyGen');
    return cleared;
  elsif p_target = 'twin' then
    select status, create_started_at, heygen_group_id is not null
      into v_status, v_started, v_has_id
    from public.avatars where id = p_id for update;
    if not found or v_started is null or v_has_id then
      return 'none';
    end if;
    if v_status <> 'failed' and v_started > now() - c_wait then
      return 'too_soon';
    end if;
    update public.avatars set create_started_at = null, error = null where id = p_id;
    insert into public.provider_usage (provider, kind, avatar_id, status, cost_usd, mock, note)
    values ('heygen', 'claim_cleared', p_id, 'succeeded', 0, false,
            'twin claim cleared by ' || coalesce(p_admin_email, 'unknown admin') || ' after checking HeyGen');
    return 'twin';
  end if;
  raise exception 'unknown claim target %', p_target;
end;
$$;

revoke execute on function public.clear_stuck_claim(text, uuid, text) from public, anon, authenticated;
grant execute on function public.clear_stuck_claim(text, uuid, text) to service_role;

-- Same as 20261122090000, plus: a cleared (retired) row is never claimed again.
create or replace function public.claim_render_slot(p_video_id uuid, p_max int)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v record;
  busy int;
begin
  perform pg_advisory_xact_lock(hashtext('heygen_render_slots'));
  select status, heygen_video_id, render_started_at, claim_cleared_at into v
  from public.videos where id = p_video_id for update;
  if not found then
    return 'missing';
  end if;
  if v.heygen_video_id is not null or v.render_started_at is not null or v.claim_cleared_at is not null
     or v.status not in ('queued', 'failed') then
    return 'taken';
  end if;
  select count(*) into busy from public.videos where status = 'rendering';
  if busy >= p_max then
    return 'busy';
  end if;
  update public.videos set status = 'rendering', render_started_at = now(), error = null where id = p_video_id;
  return 'claimed';
end;
$$;

revoke execute on function public.claim_render_slot(uuid, int) from public, anon, authenticated;
grant execute on function public.claim_render_slot(uuid, int) to service_role;

create or replace function public.adopt_late_render(p_video_id uuid, p_heygen_video_id text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v record;
  v_post uuid;
  newer boolean;
begin
  select id, kind, script_id, avatar_id, engine, status, heygen_video_id, render_started_at, claim_cleared_at into v
  from public.videos where id = p_video_id for update;
  if not found or v.status <> 'failed' or v.heygen_video_id is not null
     or (v.render_started_at is null and v.claim_cleared_at is null) then
    return 'not_late';
  end if;

  if v.kind = 'post' then
    select post_id into v_post from public.scripts where id = v.script_id;
    select exists (
      select 1 from public.videos o join public.scripts s on s.id = o.script_id
      where s.post_id = v_post and o.id <> v.id and o.status not in ('failed', 'skipped')
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
        error = 'HeyGen finished this video late, after a newer render was started. The newer one was kept; the late HeyGen id is saved.'
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
