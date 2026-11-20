// LLM access with a request-level cache, a spend ledger and a budget guard
// (BENCH.md §4.4, §4.5).
//
// llm_key = sha256(canonical_json({model, messages, params, sample}))
//   params = everything sent to the API except model/messages (tools, temperature, max_tokens)
//   sample = repeat index; part of the key, never sent.
// Cache entries hold the request body and full response, never headers/keys/baseUrl.

import fs from "node:fs";
import path from "node:path";
import { hashOf, readJsonl, appendJsonlLine, writeFileAtomic, RUNS_DIR } from "../util.js";
import { models as loadModels } from "../config.js";
import { authHeaders, redact } from "./secrets.js";
import { normUsage, costOf, worstCase } from "./pricing.js";

export class BudgetExceeded extends Error {}
export class OfflineMiss extends Error {}
export class InfraError extends Error {}

const CACHE_DIR = path.join(RUNS_DIR, "cache", "llm");
const LEDGER = path.join(RUNS_DIR, "ledger.jsonl");

export const cachePath = (key) => path.join(CACHE_DIR, key.slice(0, 2), `${key}.json`);

export function readCache(key) {
  const p = cachePath(key);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function readLedger() {
  return readJsonl(LEDGER);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LlmClient {
  /**
   * @param {object} o
   * @param {string} o.stage      ledger stage for spend accounting
   * @param {number} o.budgetUsd  hard cap for the stage (ledger total)
   * @param {boolean} o.offline   cache miss -> error, never send
   */
  constructor({ stage, budgetUsd, offline = false, log = console.log }) {
    this.stage = stage;
    this.budgetUsd = budgetUsd;
    this.offline = offline;
    this.log = log;
    const cfg = loadModels();
    this.providers = cfg.providers;
    this.modelProvider = cfg.models;
    const ledger = readLedger();
    this.spentBefore = ledger.filter((l) => l.stage === stage).reduce((s, l) => s + (l.cost_usd ?? 0), 0);
    this.ledgerKeys = new Set(ledger.map((l) => l.llm_key));
    this.spentNow = 0;
    this.reserved = 0;
    this.stats = { cache_hits: 0, requests: 0, duplicate_requests: 0, retries: 0, errors: 0 };
    this.stopped = false;
  }

  spent() {
    return this.spentBefore + this.spentNow;
  }

  provider(model) {
    const id = this.modelProvider[model];
    const p = this.providers[id];
    if (!p) throw new Error(`model ${model} has no provider in models.yaml`);
    return { id, ...p };
  }

  static key({ model, messages, params, sample }) {
    return hashOf({ model, messages, params, sample });
  }

  /**
   * Returns { llm_key, cache_hit, response, usage, cost_usd } where cost_usd is the
   * original cost of the response (also for cache hits; spent-now is 0 then).
   */
  async complete({ model, messages, params, sample, meta = {} }) {
    const llm_key = LlmClient.key({ model, messages, params, sample });
    const cached = readCache(llm_key);
    if (cached) {
      this.stats.cache_hits++;
      return { llm_key, cache_hit: true, response: cached.response, usage: cached.usage, cost_usd: cached.cost_usd };
    }
    if (this.offline) throw new OfflineMiss(`offline: cache miss for ${llm_key.slice(0, 12)} (${meta.cell ?? ""} turn ${meta.turn ?? "?"})`);
    if (this.stopped) throw new BudgetExceeded("budget reached; not starting new requests");

    const body = { model, messages, ...params, stream: false };
    const estInput = Math.ceil(JSON.stringify(messages).length / 2.5) + Math.ceil(JSON.stringify(params.tools ?? []).length / 2.5);
    const worst = worstCase(model, estInput, params.max_tokens ?? 8192);
    if (this.spent() + this.reserved + worst > this.budgetUsd) {
      this.stopped = true;
      throw new BudgetExceeded(
        `budget guard: spent $${this.spent().toFixed(4)} + in-flight $${this.reserved.toFixed(4)} + worst-case $${worst.toFixed(4)} > $${this.budgetUsd}`,
      );
    }
    if (this.ledgerKeys.has(llm_key)) this.stats.duplicate_requests++; // should never happen; reported

    this.reserved += worst;
    try {
      const provider = this.provider(model);
      const response = await this.#post(provider, body, meta.session ?? `luajs-bench-${llm_key.slice(0, 16)}`);
      const at = new Date();
      const usage = normUsage(response.usage);
      const computed = costOf(model, usage, at);
      // Prefer the provider's own list cost (includes peak multipliers / cache writes).
      const listCost = response.usage?.opencode?.list_cost;
      const cost_usd = typeof listCost === "number" ? listCost : computed;
      const finish = response.choices?.[0]?.finish_reason;
      this.stats.requests++;
      this.spentNow += cost_usd;
      this.ledgerKeys.add(llm_key);
      appendJsonlLine(LEDGER, {
        llm_key,
        stage: this.stage,
        model,
        usage,
        cost_usd,
        cost_computed_usd: computed,
        finish_reason: finish ?? null,
        cell: meta.cell ?? null,
        turn: meta.turn ?? null,
        at: at.toISOString(),
      });
      // Cache only complete, successful responses.
      if (response.choices?.[0]?.message && ["stop", "tool_calls", "length", "function_call"].includes(finish ?? "stop")) {
        writeFileAtomic(
          cachePath(llm_key),
          JSON.stringify({ llm_key, model, request: body, sample, response, usage, cost_usd, created_at: at.toISOString() }),
        );
      }
      return { llm_key, cache_hit: false, response, usage, cost_usd };
    } finally {
      this.reserved -= worst;
    }
  }

  async #post(provider, body, session) {
    const url = `${provider.base_url.replace(/\/$/, "")}/chat/completions`;
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        this.stats.retries++;
        await sleep(Math.min(30_000, 2000 * 2 ** (attempt - 1)));
      }
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "luajs-bench/0.1",
            "x-opencode-session": session, // stable per episode; routing + prompt caching
            ...authHeaders(provider),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(300_000),
        });
        const text = await res.text();
        if (res.ok) {
          const json = JSON.parse(text);
          if (json.error) throw new InfraError(`provider error: ${redact(JSON.stringify(json.error)).slice(0, 300)}`);
          return json;
        }
        lastErr = new InfraError(`HTTP ${res.status}: ${redact(text).slice(0, 300)}`);
        if (!(res.status === 429 || res.status >= 500)) break; // non-retryable
      } catch (e) {
        lastErr = e instanceof InfraError ? e : new InfraError(`network: ${redact(e?.message ?? e)}`);
      }
      this.log(`[llm] ${body.model}: attempt ${attempt + 1} failed: ${lastErr.message}`);
    }
    this.stats.errors++;
    throw lastErr;
  }
}
