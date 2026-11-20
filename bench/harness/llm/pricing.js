import { pricing } from "../config.js";

const table = pricing();

export function priceFor(model) {
  const p = table.models[model];
  if (!p) throw new Error(`no price for model ${model} in pricing.yaml`);
  return p;
}

export function multiplierAt(model, date = new Date()) {
  const peak = priceFor(model).peak;
  if (!peak) return 1;
  const d = date.getUTCDay();
  const h = date.getUTCHours() + date.getUTCMinutes() / 60;
  if (!peak.utc_days.includes(d)) return 1;
  return peak.utc_hours.some(([a, b]) => h >= a && h < b) ? peak.factor : 1;
}

/** Normalize OpenAI-style usage. */
export function normUsage(u = {}) {
  const input = u.prompt_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;
  const output = u.completion_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  return { input, cached_input: cached, output, reasoning };
}

export function costOf(model, usage, date = new Date()) {
  const p = priceFor(model);
  const m = multiplierAt(model, date);
  const fresh = Math.max(0, usage.input - usage.cached_input);
  return ((fresh * p.input + usage.cached_input * p.cached_input + usage.output * p.output) / 1e6) * m;
}

/** Worst-case cost of one request, used by the pre-request budget check. */
export function worstCase(model, estInputTokens, maxTokens, date = new Date()) {
  const p = priceFor(model);
  return ((estInputTokens * p.input + maxTokens * p.output) / 1e6) * Math.max(multiplierAt(model, date), p.peak?.factor ?? 1);
}
