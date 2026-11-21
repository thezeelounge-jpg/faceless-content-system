-- Phase 2: one small Claude call can cost less than $0.0001, which
-- numeric(10, 4) rounds to zero. Keep 6 decimal places (like lib/ai-prices.ts).
alter table public.ai_usage
  alter column cost_usd type numeric(12, 6);
