-- p5-a: create_post_render re-checks that the script PASSED QA (scripts.qa_status = 'passed').
--
-- lib/render.ts createPostRender already refuses a script that has not passed
-- ("The script has not passed its checks."), but the database did not: a direct
-- rpc call (or a race where the script's QA changed after that check) could
-- queue a paid render for a pending / failed / team_review script. Now the
-- function answers 'not_approved' (the app's plain "Only an approved script can
-- be made into a video.") and inserts nothing.
--
-- Everything else is unchanged from 20261122180000 (same per-post advisory
-- lock, same 'existing' / 'other_script' answers). CREATE OR REPLACE keeps the
-- grants; they are re-stated so this file is safe to run again.

create or replace function public.create_post_render(
  p_post_id uuid, p_script_id uuid, p_brand_id uuid, p_avatar_id uuid, p_engine text, p_spoken_words int)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_latest uuid;
  v_latest_qa text;
  v_existing uuid;
  v_existing_script uuid;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('post_render'), hashtext(p_post_id::text));

  select status into v_status from public.posts where id = p_post_id and brand_id = p_brand_id;
  select id, qa_status into v_latest, v_latest_qa
  from public.scripts where post_id = p_post_id order by version desc, created_at desc limit 1;
  -- p5-a: the newest script must also have passed QA.
  if v_status is distinct from 'approved' or v_latest is distinct from p_script_id or v_latest_qa is distinct from 'passed' then
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
