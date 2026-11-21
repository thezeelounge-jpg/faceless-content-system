-- Phase 3 part B, step 1 (SF2): never create two HeyGen twins for one consent.
--
-- HeyGen's docs (as far as we could check) document no idempotency key for
-- POST /v3/avatars, so we keep our own claim: create_started_at is set
-- atomically (update ... where heygen_group_id is null and create_started_at
-- is null) right BEFORE the paid POST. A retry after a crash finds the claim
-- and refuses, asking the admin to check HeyGen, instead of making a second twin.

alter table public.avatars add column create_started_at timestamptz;
