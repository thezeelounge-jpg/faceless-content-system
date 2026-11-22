-- Fix pass p4-fix e (QA SHOULD FIX 4): the ONLY supported way to lift
-- app_settings.renders_paused (set by the daily cap, lib/heygen-spend.ts).
-- Admin → Settings → "Resume renders" (requireAdmin, zod, an explicit "I
-- checked today's HeyGen spend" box) calls resume_renders, which in ONE
-- transaction:
--   - locks the renders_paused row; if it is not paused, answers
--     'not_paused' and writes nothing;
--   - sets it to false;
--   - writes the audit row: provider_usage kind 'renders_resumed', status
--     succeeded, cost 0, mock false, the admin's email in note.
-- reserve_heygen_spend counts only rows of its own kind ('render' /
-- 'create_twin'), so this audit row never counts toward a cap.
-- service_role only, search_path = ''.

alter table public.provider_usage drop constraint provider_usage_kind_check;
alter table public.provider_usage add constraint provider_usage_kind_check
  check (kind in ('create_twin', 'render', 'other', 'claim_cleared', 'renders_resumed'));

create or replace function public.resume_renders(p_admin_email text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  current_value jsonb;
begin
  select value into current_value from public.app_settings where key = 'renders_paused' for update;
  -- Same reading as the app (lib/heygen-spend-store.ts): only a plain false is "running".
  if not found or current_value = 'false'::jsonb then
    return 'not_paused';
  end if;
  update public.app_settings set value = 'false'::jsonb, updated_at = now() where key = 'renders_paused';
  insert into public.provider_usage (provider, kind, status, cost_usd, mock, note)
  values ('heygen', 'renders_resumed', 'succeeded', 0, false,
          'renders resumed by ' || coalesce(p_admin_email, 'unknown admin') || ' after checking today''s HeyGen spend');
  return 'resumed';
end;
$$;

revoke execute on function public.resume_renders(text) from public, anon, authenticated;
grant execute on function public.resume_renders(text) to service_role;
