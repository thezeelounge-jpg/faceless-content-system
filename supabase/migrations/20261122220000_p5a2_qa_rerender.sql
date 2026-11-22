-- p5-a2 (Phase 5, Gates 3 and 4). Written to be re-run safely (IF NOT EXISTS / CREATE OR REPLACE).
--
-- 1. videos.edit_manifest: what the editor actually built (caption pages and word timings, b-roll
--    cuts, the music bed and its gain, label/watermark). Gate 4 checks the edit against it.
-- 2. videos.rerender_of + videos.qa_fix_note: a Gate 3 re-render points at the video it replaced
--    and says which automatic fix made it (the next Gate 3 qa_reports row repeats it in auto_fix).
-- 3. rpc create_qa_rerender: the ONE automatic re-render of QA-SPEC Gate 3 ("re-render once, our
--    cost"). Under the same per-post advisory lock as create_post_render and adopt_late_render, so it
--    can never race "Make video" or a late webhook into two active videos. The checked video must be
--    'audio_qa', a post render, attempt 1 (AUDIO_QA.max_rerenders = 1 in lib/qa/config.ts; a test
--    checks they match) and still say the post's newest script. It becomes 'failed' and one new
--    'queued' video is inserted: attempt + 1, counts_toward_plan = false (our failures never count),
--    same script, twin, engine, ai_label and watermark. The render itself then goes through the
--    normal path (lib/render.ts renderVideo: spend guard, claim, 10-at-once cap).
--
-- New columns are server only: the customer column grants (20261122100000) are not widened.

alter table public.videos add column if not exists edit_manifest jsonb;
alter table public.videos add column if not exists rerender_of uuid references public.videos (id) on delete set null;
alter table public.videos add column if not exists qa_fix_note text;

create or replace function public.create_qa_rerender(p_video_id uuid, p_spoken_words int, p_fix_note text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_post uuid;
  v_video public.videos%rowtype;
  v_latest uuid;
  v_id uuid;
begin
  select post_id into v_post from public.videos where id = p_video_id;
  if v_post is null then
    return jsonb_build_object('outcome', 'not_found', 'video_id', null);
  end if;
  perform pg_advisory_xact_lock(hashtext('post_render'), hashtext(v_post::text));

  select * into v_video from public.videos where id = p_video_id for update;
  if v_video.kind is distinct from 'post' then
    return jsonb_build_object('outcome', 'not_found', 'video_id', null);
  end if;
  if v_video.status is distinct from 'audio_qa' then
    return jsonb_build_object('outcome', 'not_allowed', 'video_id', null);
  end if;
  -- AUDIO_QA.max_rerenders (lib/qa/config.ts): only an original render may be re-rendered.
  if v_video.attempt > 1 then
    return jsonb_build_object('outcome', 'limit', 'video_id', null);
  end if;
  select id into v_latest from public.scripts where post_id = v_post order by version desc, created_at desc limit 1;
  if v_latest is distinct from v_video.script_id then
    return jsonb_build_object('outcome', 'not_allowed', 'video_id', null);
  end if;

  update public.videos
  set status = 'failed', error = 'Failed the audio check (Gate 3); re-rendered once at our cost.'
  where id = v_video.id;

  insert into public.videos (
    brand_id, post_id, script_id, avatar_id, kind, engine, spoken_words, attempt,
    counts_toward_plan, ai_label, watermark, rerender_of, qa_fix_note)
  values (
    v_video.brand_id, v_post, v_video.script_id, v_video.avatar_id, 'post', v_video.engine, p_spoken_words, v_video.attempt + 1,
    false, v_video.ai_label, v_video.watermark, v_video.id, left(p_fix_note, 1000))
  returning id into v_id;
  return jsonb_build_object('outcome', 'created', 'video_id', v_id);
end;
$$;

revoke execute on function public.create_qa_rerender(uuid, int, text) from public, anon, authenticated;
grant execute on function public.create_qa_rerender(uuid, int, text) to service_role;
