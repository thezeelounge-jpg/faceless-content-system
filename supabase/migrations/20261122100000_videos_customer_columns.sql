-- Fix pass p3-fix2, QA SHOULD FIX 2: customers could SELECT every column of
-- their own videos rows (HeyGen ids, engine, errors, storage keys, claims...).
--
-- Now (Postgres column privileges, https://www.postgresql.org/docs/current/sql-grant.html;
-- Supabase "Column Level Security" guide):
-- - authenticated loses the table-wide SELECT and gets SELECT on the plain
--   columns only: id, brand_id, script_id, status, duration_s, ai_label, created_at.
-- - Server only (service_role keeps everything): avatar_id, engine, attempt,
--   heygen_video_id, raw_path, transcript, final_path, counts_toward_plan,
--   watermark, error, kind, spoken_words, render_started_at, rendered_at.
--   Any NEW videos column is server only until a migration grants it.
-- - Likeness-test rows are admin only: the read-own policy now also needs
--   kind = 'post'.
-- - anon still gets nothing. Writes stay in server code with the secret key.
-- Customer screens (Phase 6) must select the listed columns by name;
-- `select *` is refused. Server code reads videos with the secret key only.

revoke select on public.videos from authenticated;
grant select (id, brand_id, script_id, status, duration_s, ai_label, created_at) on public.videos to authenticated;

drop policy "videos: read own" on public.videos;
create policy "videos: read own" on public.videos
  for select to authenticated
  using (public.owns_brand(brand_id) and kind = 'post');
