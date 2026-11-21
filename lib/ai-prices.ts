// Claude prices, used only to estimate cost in ai_usage.
//
// !!! ESTIMATES. Re-check every number at https://www.anthropic.com/pricing
// !!! before trusting the "Usage & spend" page. Last checked: never (Phase 2 build).
//
// US dollars per 1 million tokens. Cache writes (5 minute) cost 1.25x input,
// cache reads cost 0.1x input.

export type ModelPrice = { input: number; output: number };

export const MODEL_PRICES_USD_PER_MTOK: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 1, output: 5 },
};

export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** Unknown models are priced like the most expensive one, so we never under-count. */
const FALLBACK_PRICE: ModelPrice = Object.values(MODEL_PRICES_USD_PER_MTOK).reduce((max, price) =>
  price.output > max.output ? price : max,
);

export function priceFor(model: string): ModelPrice {
  return MODEL_PRICES_USD_PER_MTOK[model] ?? FALLBACK_PRICE;
}

export type TokenCounts = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/** Estimated cost in US dollars, rounded to 6 decimals. */
export function estimateCostUsd(model: string, tokens: TokenCounts): number {
  const price = priceFor(model);
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  const cost =
    tokens.input_tokens * perToken(price.input) +
    (tokens.cache_creation_input_tokens ?? 0) * perToken(price.input) * CACHE_WRITE_MULTIPLIER +
    (tokens.cache_read_input_tokens ?? 0) * perToken(price.input) * CACHE_READ_MULTIPLIER +
    tokens.output_tokens * perToken(price.output);
  return Math.round(cost * 1_000_000) / 1_000_000;
}
