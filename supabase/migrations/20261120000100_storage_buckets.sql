-- Private storage buckets (Phase 1).
-- No storage policies on purpose: only server code (secret key) can read or
-- write. Customers upload and download through short-lived signed URLs that
-- our server creates after checking permissions (Phase 3 onward).
--
-- Size note: the Supabase Free plan caps each file at 50 MB. Consent clips
-- (about 2 minutes of phone video) are usually bigger, so move to the Pro plan
-- and raise the global file size limit before real clients upload.

insert into storage.buckets (id, name, public, allowed_mime_types)
values
  ('consent-clips', 'consent-clips', false, array['video/mp4', 'video/quicktime', 'video/webm']),
  ('videos', 'videos', false, array['video/mp4', 'application/x-subrip', 'text/vtt', 'application/json']),
  ('assets', 'assets', false, null)
on conflict (id) do nothing;
