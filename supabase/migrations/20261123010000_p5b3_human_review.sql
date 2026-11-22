-- p5-b3 (Phase 5, Gate 6: the admin QA queue). Written to be re-run safely
-- (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS).
--
-- 1. videos.delivered_at: when the video reached the customer (Quality page: "time from approval to
--    Ready"). Server only (the customer column grants of 20261122100000 are not widened).
-- 2. deliver_post_video (20261123000000) re-stated: identical, plus delivered_at = now().
-- 3. provider_usage kind 'human_review': the audit row of a Gate 6 decision (cost 0, never a spend:
--    reserve_heygen_spend counts only 'render' / 'create_twin').
-- 4. rpc review_queued_video(video, decision, checklist, reason, note, admin_email): the operator's
--    Approve / Reject in Admin → QA queue (app/admin/qa/actions.ts calls it after requireAdmin + zod).
--    Under the per-post render lock (same as create_post_render, deliver_post_video, ...), video row
--    locked. Only a post video still in 'team_review' (else 'not_in_queue': a double submit changes
--    nothing).
--    approve: EVERY checklist item ticked (else 'checklist_incomplete') and a finished edit
--      (final_path, else 'no_final_file'): the usage rule as deliver_post_video (this video counts,
--      every other video of the post does not), video + post → ready, delivered_at = now().
--    reject: a known reason (else 'bad_input'): video → failed (never counted), post → problem
--      (PRODUCT.md: "Taking a little longer. We're fixing it.") with the reason.
--    Both: ONE qa_reports row (gate 'human'; QA-SPEC "saved to qa_reports with gate human") and ONE
--    provider_usage audit row, in this one transaction. service_role only.
-- The checklist and reason lists equal lib/qa/human-review.ts (tests/db/rls.test.ts checks).

alter table public.videos add column if not exists delivered_at timestamptz;

alter table public.provider_usage drop constraint if exists provider_usage_kind_check;
alter table public.provider_usage add constraint provider_usage_kind_check
  check (kind in ('create_twin', 'render', 'other', 'claim_cleared', 'renders_resumed', 'script_override', 'human_review'));

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
  update public.videos set status = 'ready', counts_toward_plan = true, error = null, delivered_at = now() where id = v_video.id;
  update public.posts set status = 'ready', status_reason = null where id = v_post;
  return jsonb_build_object('outcome', 'delivered');
end;
$$;

revoke execute on function public.deliver_post_video(uuid) from public, anon, authenticated;
grant execute on function public.deliver_post_video(uuid) to service_role;

create or replace function public.review_queued_video(
  p_video_id uuid, p_decision text, p_checklist jsonb, p_reason text, p_note text, p_admin text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_post uuid;
  v_video public.videos%rowtype;
  v_item text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_decision is null or p_decision not in ('approve', 'reject') or p_admin is null or btrim(p_admin) = '' then
    return jsonb_build_object('outcome', 'bad_input');
  end if;
  if p_decision = 'reject' and (p_reason is null or p_reason not in
      ('pronunciation', 'lip_sync', 'looks_real', 'captions', 'broll', 'music', 'label', 'other')) then
    return jsonb_build_object('outcome', 'bad_input');
  end if;

  select post_id into v_post from public.videos where id = p_video_id;
  if v_post is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtext('post_render'), hashtext(v_post::text));

  select * into v_video from public.videos where id = p_video_id for update;
  if v_video.kind is distinct from 'post' then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_video.status is distinct from 'team_review' then
    return jsonb_build_object('outcome', 'not_in_queue');
  end if;

  if p_decision = 'approve' then
    foreach v_item in array array['pronunciation', 'lip_sync', 'looks_real', 'captions', 'broll', 'music', 'label'] loop
      if jsonb_typeof(p_checklist) is distinct from 'object' or (p_checklist -> v_item) is distinct from 'true'::jsonb then
        return jsonb_build_object('outcome', 'checklist_incomplete');
      end if;
    end loop;
    if v_video.final_path is null then
      return jsonb_build_object('outcome', 'no_final_file');
    end if;

    update public.videos set counts_toward_plan = false where post_id = v_post and id <> v_video.id and counts_toward_plan;
    update public.videos set status = 'ready', counts_toward_plan = true, error = null, delivered_at = now() where id = v_video.id;
    update public.posts set status = 'ready', status_reason = null where id = v_post;
    insert into public.qa_reports (video_id, script_id, gate, passed, issues)
    values (v_video.id, v_video.script_id, 'human', true, '[]'::jsonb);
    insert into public.provider_usage (provider, kind, video_id, status, cost_usd, mock, note)
    values ('other', 'human_review', v_video.id, 'succeeded', 0, false,
            'video ' || v_video.id || ' of post ' || v_post || ' approved by ' || p_admin || ' (every checklist item ticked)');
    return jsonb_build_object('outcome', 'approved', 'brand_id', v_video.brand_id);
  end if;

  update public.videos
  set status = 'failed', counts_toward_plan = false,
      error = left('Rejected in the QA queue (' || p_reason || ')' || coalesce(': ' || v_note, ''), 1000)
  where id = v_video.id;
  update public.posts
  set status = 'problem', status_reason = left('Rejected in the QA queue (' || p_reason || ')' || coalesce(': ' || v_note, ''), 1000)
  where id = v_post;
  insert into public.qa_reports (video_id, script_id, gate, passed, issues)
  values (v_video.id, v_video.script_id, 'human', false,
          jsonb_build_array(jsonb_build_object('code', 'human_' || p_reason, 'detail', coalesce(v_note, p_reason),
                                               'at_seconds', null, 'severity', 'hard')));
  insert into public.provider_usage (provider, kind, video_id, status, cost_usd, mock, note)
  values ('other', 'human_review', v_video.id, 'succeeded', 0, false,
          left('video ' || v_video.id || ' of post ' || v_post || ' rejected by ' || p_admin || ' (' || p_reason || ')'
               || coalesce(': ' || v_note, ''), 1000));
  return jsonb_build_object('outcome', 'rejected');
end;
$$;

revoke execute on function public.review_queued_video(uuid, text, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.review_queued_video(uuid, text, jsonb, text, text, text) to service_role;
