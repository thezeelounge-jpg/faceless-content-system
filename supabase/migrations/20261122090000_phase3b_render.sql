-- Phase 3 part B, step 2: renders (lib/render.ts), likeness tests (lib/likeness.ts)
-- and HeyGen webhooks (lib/heygen-webhook.ts).
--
-- videos (customers keep their existing read-own policy and SELECT grant;
-- all writes stay in server code with the secret key):
-- - kind: 'post' (a real video for a post) or 'likeness_test' (one per engine,
--   only for the admin to compare). Likeness tests never count toward a plan.
-- - spoken_words: words in the text sent to HeyGen; with duration_s it gives
--   brands.words_per_second (rolling average of the last 10 post renders).
-- - render_started_at: our own claim, set atomically right BEFORE the paid
--   POST /v3/videos (HeyGen documents no idempotency key for it). A retry that
--   finds a claim never POSTs again.
-- - rendered_at: when the raw MP4 landed in Storage.
-- - status 'rendered': raw MP4 saved, waiting for the next gate (Phase 4/5).
--
-- webhook_events already exists (Phase 1): server only, unique event_key.
-- Raw MP4s go into the existing PRIVATE 'videos' bucket under raw/.

alter table public.videos
  add column kind text not null default 'post' check (kind in ('post', 'likeness_test')),
  add column spoken_words int check (spoken_words is null or spoken_words >= 0),
  add column render_started_at timestamptz,
  add column rendered_at timestamptz;

alter table public.videos
  add constraint videos_likeness_test_not_counted check (kind = 'post' or counts_toward_plan = false);

alter table public.videos drop constraint videos_status_check;
alter table public.videos add constraint videos_status_check
  check (status in ('queued', 'rendering', 'rendered', 'audio_qa', 'editing', 'final_qa', 'team_review',
                    'needs_you', 'ready', 'failed', 'skipped'));

create index videos_brand_kind_rendered_idx on public.videos (brand_id, kind, rendered_at desc);
create index videos_avatar_id_idx on public.videos (avatar_id);

-- Claim one render slot, atomically:
-- - 'missing'  no such video
-- - 'taken'    already claimed or already sent to HeyGen (never POST twice)
-- - 'busy'     p_max videos are already rendering (HeyGen allows 10 at once
--              on Pay-As-You-Go): the caller waits and tries again
-- - 'claimed'  status → rendering, render_started_at → now()
-- One advisory lock for all renders, so two claims at the same moment can't
-- both slip under the cap.
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
  select status, heygen_video_id, render_started_at into v
  from public.videos where id = p_video_id for update;
  if not found then
    return 'missing';
  end if;
  if v.heygen_video_id is not null or v.render_started_at is not null or v.status not in ('queued', 'failed') then
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
