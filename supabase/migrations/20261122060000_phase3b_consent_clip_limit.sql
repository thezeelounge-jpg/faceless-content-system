-- Phase 3 part B, step 1, decision 4: consent clips are capped at 50 MB
-- (52428800 bytes), the Supabase Free plan per-file limit. The app checks the
-- same cap in the browser, in prepareUpload and on the stored file
-- (lib/consent-upload-rules.ts). storage.buckets.file_size_limit is in bytes;
-- the project's global limit still wins if it is lower.

update storage.buckets
set file_size_limit = 52428800
where id = 'consent-clips';
