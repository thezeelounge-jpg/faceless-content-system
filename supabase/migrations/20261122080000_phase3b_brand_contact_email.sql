-- Phase 3 part B, step 1, decision 6: done-for-you brands are owned by the
-- admin until the Phase 6 handover, so the client's own email lives here.
-- HeyGen's consent link goes to it (plus an admin copy); reshoot tips go to
-- the admins only. Emails are still only email_outbox rows ('mocked').
-- brands keeps its RLS and grants (customers read their own brand).

alter table public.brands
  add column contact_email text check (contact_email is null or contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
