-- p4-b1 (Rowan 5c): twins get their own "Clear stuck claim" wait.
-- Replaces clear_stuck_claim from 20261122130000 (that file is on staging and
-- is never edited). Everything is the same except the twin branch: a twin
-- claim may be cleared only after the twin poll's maximum total wait
-- (TWIN_POLL_MAX_S in lib/qa/config.ts = 99060 s, about 27.5 hours: the sum
-- of the waits between the poll's 60 checks), or at once when the twin failed.
-- Renders and likeness tests keep RENDER.poll_max_s (1800 s).
-- tests/db/rls.test.ts checks both numbers equal the TypeScript constants.

create or replace function public.clear_stuck_claim(p_target text, p_id uuid, p_admin_email text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  -- Must equal RENDER.poll_max_s (lib/qa/config.ts); tests/db/rls.test.ts checks it.
  c_wait constant interval := interval '1800 seconds';
  -- Must equal TWIN_POLL_MAX_S (lib/qa/config.ts); tests/db/rls.test.ts checks it.
  c_twin_wait constant interval := interval '99060 seconds';
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
    if v_status <> 'failed' and v_started > now() - c_twin_wait then
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
