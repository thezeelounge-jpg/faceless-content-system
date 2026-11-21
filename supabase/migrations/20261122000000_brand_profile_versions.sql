-- Phase 2: brand profile versions.
-- Every generated or edited brand profile is saved as a new brand_versions row,
-- and brands.current_version / profile_md / pillars point at the latest one.
-- The function does this in one transaction with a row lock, so two saves at
-- the same moment can never get the same version number.

alter table public.brand_versions
  add column source text not null default 'edited' check (source in ('generated', 'edited'));

create or replace function public.save_brand_version(
  p_brand_id uuid,
  p_profile_md text,
  p_pillars jsonb,
  p_source text
)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_next int;
begin
  if jsonb_typeof(p_pillars) is distinct from 'array'
     or jsonb_array_length(p_pillars) not between 4 and 6 then
    raise exception 'A brand profile needs 4 to 6 pillars.' using errcode = '22023';
  end if;

  select b.current_version + 1 into v_next
  from public.brands b
  where b.id = p_brand_id
  for update;

  if not found then
    raise exception 'Brand % not found.', p_brand_id using errcode = 'P0002';
  end if;

  insert into public.brand_versions (brand_id, version, profile_md, pillars, source)
  values (p_brand_id, v_next, p_profile_md, p_pillars, p_source);

  update public.brands
  set profile_md = p_profile_md,
      pillars = p_pillars,
      current_version = v_next
  where id = p_brand_id;

  return v_next;
end;
$$;

-- Server code only (secret key). Customers never write.
revoke execute on function public.save_brand_version(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.save_brand_version(uuid, text, jsonb, text) to service_role;
