-- Phase 3 part B, step 1, decision 2: clip checks run in a Trigger.dev task
-- (trigger/check-clip.ts), so the admin page shows where the check is.
-- null = never started; pending = queued; running; done; failed (plain
-- sentence in clip_check_error, never a raw error or a key).
-- consents keeps its existing RLS and grants (customers read their own rows).

alter table public.consents
  add column clip_check_status text check (clip_check_status in ('pending', 'running', 'done', 'failed')),
  add column clip_check_error text;
