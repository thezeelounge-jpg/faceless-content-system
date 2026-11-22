-- p5-a: no script rewrites once a post has left scripting (with an audited admin override).
--
-- Why: Gate 1's one automatic rewrite (lib/qa/script-pipeline.ts runGate1 →
-- store.insertScriptVersion) had no post-status guard. Two overlapping "Run
-- checks" runs could pass v1 (post → approved / script_review) while the other
-- run still saved a v2 rewrite (the Q8 case of 20261122180000).
--
-- insert_script_version(p_row, p_override_by, p_override_reason):
--   - locks the post row (FOR UPDATE), so a concurrent "post moves on" update
--     and this insert happen one after the other, never interleaved;
--   - post planned / scripting → inserts → 'inserted' (no audit row);
--   - post anywhere else, no override → 'closed' (nothing saved);
--   - override (p_override_by = the admin's email, after requireAdmin in the
--     app): refused with 'has_video' while the post has an active post video;
--     else inserts, moves the post back to 'scripting' (status_reason cleared)
--     and writes ONE provider_usage audit row (provider 'other', kind
--     'script_override', cost 0, never a spend: reserve_heygen_spend counts
--     only 'render' / 'create_twin'), all in this one transaction → 'overridden'.
--   service_role only. Re-runnable (CREATE OR REPLACE, constraint re-made).

alter table public.provider_usage drop constraint if exists provider_usage_kind_check;
alter table public.provider_usage add constraint provider_usage_kind_check
  check (kind in ('create_twin', 'render', 'other', 'claim_cleared', 'renders_resumed', 'script_override'));

create or replace function public.insert_script_version(
  p_row jsonb, p_override_by text default null, p_override_reason text default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.scripts;
  v_status text;
  v_id uuid;
begin
  r := jsonb_populate_record(null::public.scripts, p_row);
  select status into v_status from public.posts where id = r.post_id for update;
  if v_status is null then
    return jsonb_build_object('outcome', 'not_found', 'script_id', null);
  end if;

  if v_status not in ('planned', 'scripting') then
    if p_override_by is null or btrim(p_override_by) = '' then
      return jsonb_build_object('outcome', 'closed', 'script_id', null);
    end if;
    if exists (
      select 1 from public.videos
      where post_id = r.post_id and kind = 'post' and status not in ('failed', 'skipped')
    ) then
      return jsonb_build_object('outcome', 'has_video', 'script_id', null);
    end if;
  end if;

  insert into public.scripts (post_id, version, display_text, spoken_text, hook, body, cta, est_seconds,
                              captions, hashtags, broll_keywords, edit_plan, qa_status)
  values (r.post_id, r.version, r.display_text, r.spoken_text, r.hook, r.body, r.cta, r.est_seconds,
          coalesce(r.captions, '{}'::jsonb), coalesce(r.hashtags, '{}'), coalesce(r.broll_keywords, '{}'),
          coalesce(r.edit_plan, '{}'::jsonb), coalesce(r.qa_status, 'pending'))
  returning id into v_id;

  if v_status in ('planned', 'scripting') then
    return jsonb_build_object('outcome', 'inserted', 'script_id', v_id);
  end if;

  update public.posts set status = 'scripting', status_reason = null where id = r.post_id;
  insert into public.provider_usage (provider, kind, status, cost_usd, mock, note)
  values ('other', 'script_override', 'succeeded', 0, false,
          'script ' || v_id || ' (version ' || r.version || ') of post ' || r.post_id
          || ' saved after the post left scripting (was ' || v_status || ') by ' || p_override_by
          || ': ' || coalesce(nullif(btrim(p_override_reason), ''), 'no reason given'));
  return jsonb_build_object('outcome', 'overridden', 'script_id', v_id);
end;
$$;

revoke execute on function public.insert_script_version(jsonb, text, text) from public, anon, authenticated;
grant execute on function public.insert_script_version(jsonb, text, text) to service_role;
