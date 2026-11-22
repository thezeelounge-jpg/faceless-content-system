-- p5-a: follow-up to 20261122180000 (per-post active video guard).
--
-- 20261122180000 is ALREADY applied on staging, so it is NOT edited. This file
-- re-states what it set up, written to be safe to run again (IF NOT EXISTS,
-- CREATE OR REPLACE, DROP ... IF EXISTS before CREATE TRIGGER). On a database
-- where 180000 ran (staging, and every fresh chain) every statement below is a
-- no-op EXCEPT the one new thing:
--
--   grant execute on videos_fill_post_id() to service_role (QA NICE, p4-b3).
--   A trigger fires without EXECUTE, so nothing needs it today; it makes the
--   server role's rights explicit in case a hosted Postgres ever checks it.
--   Customers (anon, authenticated) still cannot run it.
--
-- Tested in tests/db/rls.test.ts ("p5-a: re-runnable migrations"): the whole
-- chain, then this file twice more, leaves the same schema.

alter table public.videos add column if not exists post_id uuid references public.posts (id) on delete set null;
comment on column public.videos.post_id is 'The post of a post video (from its script, kept by trigger videos_fill_post_id). Null for likeness tests.';
create index if not exists videos_post_id_idx on public.videos (post_id);

-- Only rows that are wrong change (none after 180000).
update public.videos v
set post_id = s.post_id
from public.scripts s
where s.id = v.script_id and v.kind = 'post' and v.post_id is distinct from s.post_id;

create or replace function public.videos_fill_post_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'post' and new.script_id is not null then
    select s.post_id into new.post_id from public.scripts s where s.id = new.script_id;
  elsif new.kind <> 'post' then
    new.post_id := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.videos_fill_post_id() from public, anon, authenticated;
grant execute on function public.videos_fill_post_id() to service_role;

drop trigger if exists videos_fill_post_id on public.videos;
create trigger videos_fill_post_id
  before insert or update of script_id, kind on public.videos
  for each row execute function public.videos_fill_post_id();

drop index if exists public.videos_one_active_post_video;
create unique index if not exists videos_one_active_post_video_per_post on public.videos (post_id)
  where kind = 'post' and post_id is not null and status not in ('failed', 'skipped');
