-- p5-b2 (Phase 5, Gate 5 visual and realism QA + the usage rule). Written to be re-run safely
-- (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS).
--
-- 1. videos.rerender_gate: which gate's automatic fix made this video ('visual' from Gate 5 here;
--    Gate 3 re-renders made before this migration keep null). Server only (the customer column
--    grants of 20261122100000 are not widened).
-- 2. rpc create_visual_rerender: Gate 5's ONE automatic re-render per script (QA-SPEC "for a face or
--    realism problem, re-render once on the same engine"; VISUAL_QA.max_fixes = 1 in lib/qa/config.ts,
--    a test checks they match). Under the same per-post advisory lock as create_post_render,
--    adopt_late_render and create_qa_rerender. The checked video must be a 'final_qa' post render of
--    the post's newest script; it becomes 'failed' and ONE new 'queued' video is inserted (attempt + 1,
--    counts_toward_plan = false: our failures never count). The render then goes through the normal
--    path (lib/render.ts renderVideo: spend guard, claim, 10-at-once cap, admin OK in real mode).
-- 3. rpc deliver_post_video: the usage rule. Only the ONE delivered video per post counts toward the
--    plan: the video goes final_qa → ready with counts_toward_plan = true, every other video of the
--    post gets counts_toward_plan = false, and the post goes to ready, in one transaction.
-- 4. brand_qa_settings: per-brand QA switches, server only (RLS on, no policies, no customer grants).
--    team_reviews_every_video: QA-SPEC Gate 6 "every video of a managed brand, until the operator
--    turns this off for that brand". No row = on.

alter table public.videos add column if not exists rerender_gate text;
alter table public.videos drop constraint if exists videos_rerender_gate_check;
alter table public.videos add constraint videos_rerender_gate_check check (rerender_gate is null or rerender_gate in ('audio', 'visual'));

create table if not exists public.brand_qa_settings (
  brand_id uuid primary key references public.brands (id) on delete cascade,
  team_reviews_every_video boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.brand_qa_settings enable row level security;
revoke all on public.brand_qa_settings from anon, authenticated;
grant all on public.brand_qa_settings to service_role;

create or replace function public.create_visual_rerender(p_video_id uuid, p_fix_note text)
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
  if v_video.status is distinct from 'final_qa' then
    return jsonb_build_object('outcome', 'not_allowed', 'video_id', null);
  end if;
  select id into v_latest from public.scripts where post_id = v_post order by version desc, created_at desc limit 1;
  if v_latest is distinct from v_video.script_id then
    return jsonb_build_object('outcome', 'not_allowed', 'video_id', null);
  end if;
  -- VISUAL_QA.max_fixes (lib/qa/config.ts): one Gate 5 re-render per script.
  if (select count(*) from public.videos where script_id = v_video.script_id and rerender_gate = 'visual') >= 1 then
    return jsonb_build_object('outcome', 'limit', 'video_id', null);
  end if;

  update public.videos
  set status = 'failed', error = 'Failed the visual check (Gate 5); re-rendered once at our cost.'
  where id = v_video.id;

  insert into public.videos (
    brand_id, post_id, script_id, avatar_id, kind, engine, spoken_words, attempt,
    counts_toward_plan, ai_label, watermark, rerender_of, rerender_gate, qa_fix_note)
  values (
    v_video.brand_id, v_post, v_video.script_id, v_video.avatar_id, 'post', v_video.engine, v_video.spoken_words, v_video.attempt + 1,
    false, v_video.ai_label, v_video.watermark, v_video.id, 'visual', left(p_fix_note, 1000))
  returning id into v_id;
  return jsonb_build_object('outcome', 'created', 'video_id', v_id);
end;
$$;

revoke execute on function public.create_visual_rerender(uuid, text) from public, anon, authenticated;
grant execute on function public.create_visual_rerender(uuid, text) to service_role;

create or replace function public.deliver_post_video(p_video_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_post uuid;
  v_video public.videos%rowtype;
begin
  select post_id into v_post from public.videos where id = p_video_id;
  if v_post is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtext('post_render'), hashtext(v_post::text));

  select * into v_video from public.videos where id = p_video_id for update;
  if v_video.kind is distinct from 'post' then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_video.status is distinct from 'final_qa' then
    return jsonb_build_object('outcome', 'not_allowed');
  end if;

  -- The usage rule: only the one delivered video of a post counts; QA failures and our re-renders never do.
  update public.videos set counts_toward_plan = false where post_id = v_post and id <> v_video.id and counts_toward_plan;
  update public.videos set status = 'ready', counts_toward_plan = true, error = null where id = v_video.id;
  update public.posts set status = 'ready', status_reason = null where id = v_post;
  return jsonb_build_object('outcome', 'delivered');
end;
$$;

revoke execute on function public.deliver_post_video(uuid) from public, anon, authenticated;
grant execute on function public.deliver_post_video(uuid) to service_role;
