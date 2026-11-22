-- p4-b1 (QA SHOULD FIX 2): one edit run at a time.
-- Part A let a row that was already 'editing' be started again (meant for a
-- retry), so two overlapping runs could both edit, and a failing one could
-- delete the final file the other had just finished.
--
-- start_edit claims the row for ONE run (edit_run_id = the Trigger.dev run
-- id, edit_started_at = now()):
--   - 'rendered' or 'audio_qa': claimed;
--   - 'editing' by the SAME run (a Trigger.dev retry after a crash keeps its
--     run id): claimed again;
--   - 'editing' by another run: refused, unless that claim is older than
--     p_stale_s (EDIT.claim_stale_s = the edit task's maxDuration; by then
--     Trigger.dev has stopped that run) or has no start time (part A rows);
--   - anything else (final_qa, team_review, ...), a likeness test, or no raw
--     file: refused.
-- lib/edit-store.ts finishes an edit only while the row is still 'editing'
-- with the same edit_run_id, and the job deletes its final file on failure
-- only when that finish succeeded (so never a file another run finished).
-- Both new columns are server only (no customer grant, see 20261122100000).

alter table public.videos add column edit_run_id text;
alter table public.videos add column edit_started_at timestamptz;

comment on column public.videos.edit_run_id is 'The edit run (Trigger.dev run id) that holds the edit claim.';
comment on column public.videos.edit_started_at is 'When that run claimed the edit.';

create or replace function public.start_edit(p_video_id uuid, p_run text, p_stale_s int)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_run is null or length(p_run) = 0 or p_stale_s is null or p_stale_s <= 0 then
    raise exception 'start_edit needs a run id and a positive stale limit';
  end if;
  update public.videos
  set status = 'editing', error = null, edit_run_id = p_run, edit_started_at = now()
  where id = p_video_id
    and kind = 'post'
    and raw_path is not null
    and (
      status in ('rendered', 'audio_qa')
      or (status = 'editing' and (
            edit_run_id = p_run
            or edit_started_at is null
            or edit_started_at < now() - make_interval(secs => p_stale_s)))
    );
  return found;
end;
$$;

revoke execute on function public.start_edit(uuid, text, int) from public, anon, authenticated;
grant execute on function public.start_edit(uuid, text, int) to service_role;
