-- p5-b4 (last Phase 5 fixes). Written to be re-run safely (IF NOT EXISTS / CREATE OR REPLACE /
-- DROP ... IF EXISTS). 20261123010000 is already on staging and is NOT edited; this file re-states
-- review_queued_video.
--
-- 1. QA SF2: table human_reviews = every Gate 6 decision (video, post, approve/reject, reason, the
--    admin's free-text note, who, when). SERVER ONLY: RLS on, no policies, nothing granted to anon /
--    authenticated. Admins see it on the client page and in the QA queue (service role, after
--    requireAdmin). Customers can read posts.status_reason, so a reject never writes the reason or
--    the note there: only the neutral sentence REJECT_CUSTOMER_REASON (lib/qa/human-review.ts,
--    tested equal), PRODUCT.md's "Taking a little longer. We're fixing it."
-- 2. Rowan 6: a reject puts the post back to 'approved' (it was 'problem', with no way back), so the
--    team can press "Make video" again. NOTHING is rendered automatically: Make video still asks for
--    the spend OK in real mode and goes through the spend guard (caps, renders_paused). The rejected
--    video is 'failed' and never counts. videos.error (server only) keeps the reason, not the note.
-- 3. Rowan 7: scripts.approved_at (in the schema since Phase 1, never set) is stamped when a post
--    becomes 'approved' while it has NO post video yet = the script was approved (by the checks via
--    finish_script_checks, or later by a person from script_review / needs_you / team_review).
--    Trigger posts_stamp_script_approved, so every approve path, today's and Phase 6's, is covered.
--    Going back to 'approved' after a video exists (claim cleared, Gate 6 reject, a QA re-render not
--    sent) is not an approval and never moves the stamp; a stamp is never overwritten.
--    Quality "time to Ready" starts at it (old rows without it: the post's first Make video).
-- service_role only; search_path = ''.

-- 1. human_reviews -------------------------------------------------------------------------------
create table if not exists public.human_reviews (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  post_id uuid references public.posts (id) on delete cascade,
  decision text not null check (decision in ('approve', 'reject')),
  reason text,
  note text,
  admin text not null,
  created_at timestamptz not null default now()
);
comment on table public.human_reviews is 'Gate 6 decisions with the admin note. Server only (RLS on, no policies): never shown to customers.';
create index if not exists human_reviews_post_id_idx on public.human_reviews (post_id, created_at);
create index if not exists human_reviews_video_id_idx on public.human_reviews (video_id);

alter table public.human_reviews enable row level security;
revoke all on table public.human_reviews from public, anon, authenticated;
grant select, insert, update, delete on table public.human_reviews to service_role;

-- 2. review_queued_video, re-stated ----------------------------------------------------------------
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

    -- The usage rule: only the one delivered video of a post counts; QA failures and our re-renders never do.
    update public.videos set counts_toward_plan = false where post_id = v_post and id <> v_video.id and counts_toward_plan;
    update public.videos set status = 'ready', counts_toward_plan = true, error = null, delivered_at = now() where id = v_video.id;
    update public.posts set status = 'ready', status_reason = null where id = v_post;
    insert into public.qa_reports (video_id, script_id, gate, passed, issues)
    values (v_video.id, v_video.script_id, 'human', true, '[]'::jsonb);
    insert into public.human_reviews (video_id, post_id, decision, reason, note, admin)
    values (v_video.id, v_post, 'approve', null, null, p_admin);
    insert into public.provider_usage (provider, kind, video_id, status, cost_usd, mock, note)
    values ('other', 'human_review', v_video.id, 'succeeded', 0, false,
            'video ' || v_video.id || ' of post ' || v_post || ' approved by ' || p_admin || ' (every checklist item ticked)');
    return jsonb_build_object('outcome', 'approved', 'brand_id', v_video.brand_id);
  end if;

  -- Reject: the video never counts; the post goes back to 'approved' (Make video again, by a person).
  update public.videos
  set status = 'failed', counts_toward_plan = false,
      error = 'Rejected in the QA queue (' || p_reason || '). See the QA queue decision for the note.'
  where id = v_video.id;
  update public.posts
  set status = 'approved', status_reason = 'Taking a little longer. We''re fixing it.'
  where id = v_post;
  insert into public.qa_reports (video_id, script_id, gate, passed, issues)
  values (v_video.id, v_video.script_id, 'human', false,
          jsonb_build_array(jsonb_build_object('code', 'human_' || p_reason, 'detail', coalesce(v_note, p_reason),
                                               'at_seconds', null, 'severity', 'hard')));
  insert into public.human_reviews (video_id, post_id, decision, reason, note, admin)
  values (v_video.id, v_post, 'reject', p_reason, left(v_note, 1000), p_admin);
  insert into public.provider_usage (provider, kind, video_id, status, cost_usd, mock, note)
  values ('other', 'human_review', v_video.id, 'succeeded', 0, false,
          left('video ' || v_video.id || ' of post ' || v_post || ' rejected by ' || p_admin || ' (' || p_reason || ')', 1000));
  return jsonb_build_object('outcome', 'rejected');
end;
$$;

revoke execute on function public.review_queued_video(uuid, text, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.review_queued_video(uuid, text, jsonb, text, text, text) to service_role;

-- 3. scripts.approved_at ---------------------------------------------------------------------------
create or replace function public.posts_stamp_script_approved()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.videos where post_id = new.id and kind = 'post') then
    update public.scripts set approved_at = now()
    where id = (select id from public.scripts where post_id = new.id order by version desc, created_at desc limit 1)
      and approved_at is null;
  end if;
  return null;
end;
$$;

revoke execute on function public.posts_stamp_script_approved() from public, anon, authenticated;
grant execute on function public.posts_stamp_script_approved() to service_role;

drop trigger if exists posts_stamp_script_approved on public.posts;
create trigger posts_stamp_script_approved
  after update of status on public.posts
  for each row
  when (new.status = 'approved' and old.status is distinct from 'approved')
  execute function public.posts_stamp_script_approved();
