-- Fix pass p3-fix2, decision (b) (Rowan): admin-only "Clear stuck claim"
-- (lib/claims.ts, app/admin/claims-actions.ts).
--
-- A claim (videos.render_started_at, avatars.create_started_at) is set right
-- before a paid HeyGen POST. When the answer is lost the row keeps the claim
-- with no HeyGen id and nothing retries it. After the admin has checked the
-- HeyGen dashboard, clear_stuck_claim frees it and writes the audit row in
-- the SAME transaction:
--   - only when the claim is set AND there is no HeyGen id (row locked with
--     the update itself, so a webhook saving the id at the same moment wins);
--   - videos (post renders and likeness tests): render_started_at → null,
--     status → failed, a plain error; a new render can then be started;
--   - avatars: create_started_at → null, error → null;
--   - audit: provider_usage kind 'claim_cleared', status succeeded, cost 0,
--     mock false, with the video or avatar id and the admin's email in note.
--     'claim_cleared' is not 'render' or 'create_twin', so it never counts
--     toward a daily cap.
-- Returns 'render' | 'likeness_test' | 'twin', or 'none' (nothing written).
-- service_role only, like the other server functions.

alter table public.provider_usage drop constraint provider_usage_kind_check;
alter table public.provider_usage add constraint provider_usage_kind_check
  check (kind in ('create_twin', 'render', 'other', 'claim_cleared'));

create or replace function public.clear_stuck_claim(p_target text, p_id uuid, p_admin_email text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  cleared text;
begin
  if p_target = 'video' then
    update public.videos
    set render_started_at = null,
        status = 'failed',
        error = 'Claim cleared by an admin after checking HeyGen. Start it again when ready.'
    where id = p_id and render_started_at is not null and heygen_video_id is null
    returning case when kind = 'likeness_test' then 'likeness_test' else 'render' end into cleared;
    if cleared is null then
      return 'none';
    end if;
    insert into public.provider_usage (provider, kind, video_id, status, cost_usd, mock, note)
    values ('heygen', 'claim_cleared', p_id, 'succeeded', 0, false,
            cleared || ' claim cleared by ' || coalesce(p_admin_email, 'unknown admin') || ' after checking HeyGen');
    return cleared;
  elsif p_target = 'twin' then
    update public.avatars
    set create_started_at = null, error = null
    where id = p_id and create_started_at is not null and heygen_group_id is null
    returning 'twin' into cleared;
    if cleared is null then
      return 'none';
    end if;
    insert into public.provider_usage (provider, kind, avatar_id, status, cost_usd, mock, note)
    values ('heygen', 'claim_cleared', p_id, 'succeeded', 0, false,
            'twin claim cleared by ' || coalesce(p_admin_email, 'unknown admin') || ' after checking HeyGen');
    return cleared;
  end if;
  raise exception 'unknown claim target %', p_target;
end;
$$;

revoke execute on function public.clear_stuck_claim(text, uuid, text) from public, anon, authenticated;
grant execute on function public.clear_stuck_claim(text, uuid, text) to service_role;
