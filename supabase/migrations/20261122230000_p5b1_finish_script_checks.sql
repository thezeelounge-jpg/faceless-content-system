-- p5-b1 (Rowan 7): the script checks (Gates 1 + 2) move the post on only for the post's
-- LATEST script version.
--
-- Why: two overlapping runs (or a run plus an admin's "Rewrite anyway") can judge an older
-- version while a newer one is already saved. Before this, the older run's verdict still
-- approved the post (or sent it to the team) and the newer version was left behind.
--
-- finish_script_checks(p_script_id, p_qa_status, p_post_status, p_status_reason):
--   - locks the post row (FOR UPDATE), the same lock insert_script_version takes, so a new
--     version and this verdict happen one after the other, never interleaved;
--   - a newer version of the post exists → 'stale': NOTHING is written (the verdict is
--     already in qa_reports; the newer version is checked by its own run);
--   - else the script's qa_status is set (when p_qa_status is not null) and the post moves
--     to p_post_status only while it is still planned / scripting → 'done', or 'moved_on'
--     when the post had already moved on (the script row is still updated, the post is not);
--   - no such script → 'not_found'.
--   service_role only. Re-runnable (CREATE OR REPLACE; revoke/grant are idempotent).

create or replace function public.finish_script_checks(
  p_script_id uuid, p_qa_status text, p_post_status text, p_status_reason text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_post uuid;
  v_version integer;
  v_status text;
begin
  if p_post_status not in ('script_review', 'approved', 'team_review', 'needs_you') then
    raise exception 'finish_script_checks: post status % is not a script-check outcome', p_post_status;
  end if;

  select post_id, version into v_post, v_version from public.scripts where id = p_script_id;
  if v_post is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select status into v_status from public.posts where id = v_post for update;
  if v_status is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if exists (select 1 from public.scripts where post_id = v_post and version > v_version) then
    return jsonb_build_object('outcome', 'stale');
  end if;

  if p_qa_status is not null then
    update public.scripts set qa_status = p_qa_status where id = p_script_id;
  end if;

  if v_status not in ('planned', 'scripting') then
    return jsonb_build_object('outcome', 'moved_on');
  end if;

  update public.posts set status = p_post_status, status_reason = p_status_reason where id = v_post;
  return jsonb_build_object('outcome', 'done');
end;
$$;

revoke execute on function public.finish_script_checks(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.finish_script_checks(uuid, text, text, text) to service_role;
