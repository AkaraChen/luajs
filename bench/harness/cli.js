#!/usr/bin/env node
// bench CLI: plan | run | status | regrade | selfcheck | check-tasks | ping
// See bench/README.md.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { manifest } from "./config.js";
import { BENCH_DIR, canonicalJson } from "./util.js";
import {
  loadTasks,
  expandStage,
  readResults,
  isDone,
  writeResult,
  fingerprints,
  checkFingerprints,
} from "./cells.js";
import { LlmClient, BudgetExceeded, OfflineMiss, readLedger } from "./llm/client.js";
import { priceFor } from "./llm/pricing.js";
import { runEpisode } from "./episode.js";
import { computeReference } from "../tasks/reference.js";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    stage: { type: "string", default: "smoke" },
    budget: { type: "string" },
    offline: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    only: { type: "string", multiple: true },
    concurrency: { type: "string" },
    write: { type: "boolean", default: false },
    "max-cells": { type: "string" },
  },
});
const cmd = positionals[0] ?? "help";

const fmt$ = (x) => `$${x.toFixed(4)}`;

function selectCells(stage) {
  const m = manifest();
  const tasks = loadTasks();
  let cells = expandStage(stage, { m, tasks });
  if (opt.only?.length) cells = cells.filter((c) => opt.only.every((o) => `${c.task_id}/${c.model}/${c.lang}/${c.repeat}`.includes(o)));
  return { m, tasks, cells };
}

function budgetFor(m, stage) {
  const cap = m.budget_usd?.[stage];
  if (cap === undefined) throw new Error(`manifest.budget_usd has no entry for ${stage}`);
  if (opt.budget === undefined) return cap;
  const b = Number(opt.budget);
  if (!(b <= cap)) throw new Error(`--budget can only lower the manifest cap ($${cap})`);
  return b;
}

// ---------------------------------------------------------------- plan
function plan(stage) {
  const { m, cells } = selectCells(stage);
  const results = readResults();
  const ledger = readLedger();
  const spent = ledger.filter((l) => l.stage === stage).reduce((s, l) => s + l.cost_usd, 0);
  const budget = budgetFor(m, stage);
  const groups = new Map();
  for (const c of cells) {
    const g = groups.get(`${c.model} ${c.lang}`) ?? { model: c.model, lang: c.lang, total: 0, pending: 0 };
    g.total++;
    if (!isDone(results.get(c.cell_key))) g.pending++;
    groups.set(`${c.model} ${c.lang}`, g);
  }
  // per-episode cost: measured average for the model if we have done rows, else BENCH.md §5 assumption
  const measured = new Map();
  for (const r of results.values()) {
    if (!isDone(r)) continue;
    const a = measured.get(r.model) ?? { n: 0, cost: 0 };
    a.n++;
    a.cost += r.cost_usd;
    measured.set(r.model, a);
  }
  let est = 0;
  console.log(`stage ${stage}: ${cells.length} cells`);
  console.log(`${"model".padEnd(22)} ${"lang".padEnd(12)} total pending  est/episode  est`);
  for (const g of groups.values()) {
    const ms = measured.get(g.model);
    const p = priceFor(g.model);
    const per = ms ? ms.cost / ms.n : (12000 * p.input + 3000 * p.output) / 1e6;
    const e = per * g.pending;
    est += e;
    console.log(`${g.model.padEnd(22)} ${g.lang.padEnd(12)} ${String(g.total).padStart(5)} ${String(g.pending).padStart(7)}  ${fmt$(per).padStart(10)}${ms ? "*" : " "} ${fmt$(e)}`);
  }
  const pending = [...groups.values()].reduce((s, g) => s + g.pending, 0);
  console.log(`(* = measured from ${[...measured.values()].reduce((s, a) => s + a.n, 0)} done episodes; otherwise 12k in / 3k out assumption)`);
  console.log(`pending cells: ${pending} / ${cells.length}`);
  console.log(`estimated cost for pending: ${fmt$(est)}`);
  console.log(`spent so far (ledger, stage ${stage}): ${fmt$(spent)}; budget ${fmt$(budget)}; remaining ${fmt$(budget - spent)}`);
  console.log(spent + est > budget ? "WARNING: estimate exceeds remaining budget" : "estimate within budget");
}

// ---------------------------------------------------------------- run
async function run(stage, { regrade = false } = {}) {
  const { m, tasks, cells } = selectCells(stage);
  if (opt["dry-run"]) return plan(stage);
  const st = m.stages[stage];
  const stale = checkFingerprints(fingerprints(m, [...new Set(cells.map((c) => c.task_id))].map((id) => tasks.get(id)), st.langs), {
    record: !opt.offline && !regrade,
  });
  if (stale.length && !regrade) {
    console.error(`refusing to run: content changed but version did not for: ${stale.join(", ")}\nbump the corresponding version in manifest.yaml / task file / world.js`);
    process.exitCode = 2;
    return;
  }
  const results = readResults();
  const budget = budgetFor(m, stage);
  const offline = opt.offline || regrade;
  const llm = new LlmClient({ stage, budgetUsd: budget, offline });
  const ledgerTurns = new Map();
  for (const l of readLedger()) if (l.cell) ledgerTurns.set(l.cell, Math.max(ledgerTurns.get(l.cell) ?? 0, l.turn ?? 0));

  let todo = regrade ? cells.filter((c) => isDone(results.get(c.cell_key))) : cells.filter((c) => !isDone(results.get(c.cell_key)));
  if (opt["max-cells"]) todo = todo.slice(0, Number(opt["max-cells"]));
  console.log(`${regrade ? "regrade" : "run"} ${stage}: ${cells.length} cells, done ${cells.filter((c) => isDone(results.get(c.cell_key))).length}, to run ${todo.length}${offline ? " (offline)" : ""}`);
  console.log(`budget ${fmt$(budget)}, spent before this process ${fmt$(llm.spent())}`);

  // interleave models so one slow provider does not serialize everything
  const queue = [...todo].sort((a, b) => a.task_id.localeCompare(b.task_id) || a.lang.localeCompare(b.lang) || a.model.localeCompare(b.model));
  const concurrency = Number(opt.concurrency ?? m.concurrency ?? 4);
  let stopping = false;
  let doneN = 0;
  let passN = 0;
  let infraN = 0;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("\nSIGINT: not starting new cells; in-flight cells are abandoned (their requests are cached). Ctrl-C again to exit now.");
  });

  async function worker() {
    while (queue.length && !stopping && !llm.stopped) {
      const cell = queue.shift();
      const task = tasks.get(cell.task_id);
      const label = `${cell.task_id} ${cell.model} ${cell.lang} r${cell.repeat}`;
      try {
        const ep = await runEpisode({ cell, task, params: m.params, llm });
        if (stopping) return; // abandoned
        const maxTurnBefore = ledgerTurns.get(cell.cell_key) ?? 0;
        const nondeterministic = ep.turns.some((t) => !t.cache_hit && t.turn <= maxTurnBefore);
        const row = { ...cell, stage, status: "done", ...ep, nondeterministic, finished_at: new Date().toISOString() };
        if (regrade) row.regraded_at = row.finished_at;
        writeResult(row);
        doneN++;
        if (ep.pass) passN++;
        const hits = ep.turns.filter((t) => t.cache_hit).length;
        console.log(
          `[${doneN}/${todo.length}] ${ep.pass ? "PASS" : "FAIL"} ${label} turns=${ep.n_turns} cache=${hits}/${ep.turns.length} cost=${fmt$(ep.cost_usd)}` +
            `${ep.fail_tag ? ` tag=${ep.fail_tag}` : ""}${ep.fanout ? ` fanout=${ep.fanout.join("+") || "-"}` : ""}${nondeterministic ? " NONDETERMINISTIC" : ""}`,
        );
      } catch (e) {
        if (e instanceof BudgetExceeded) {
          console.log(`[budget] ${label}: ${e.message}`);
          return;
        }
        if (e instanceof OfflineMiss) {
          console.log(`[offline] ${label}: ${e.message}`);
          continue;
        }
        infraN++;
        console.log(`[infra_error] ${label}: ${e.message}`);
        writeResult({ ...cell, stage, status: "infra_error", error: String(e.message).slice(0, 500), finished_at: new Date().toISOString() });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const s = llm.stats;
  console.log("\n---- summary ----");
  console.log(`cells finished this process: ${doneN} (pass ${passN}), infra errors: ${infraN}, not started: ${queue.length}`);
  console.log(`llm: cache_hits=${s.cache_hits} new_requests=${s.requests} duplicate_requests=${s.duplicate_requests} retries=${s.retries} failed_requests=${s.errors}`);
  console.log(`spent this process ${fmt$(llm.spentNow)}; stage total ${fmt$(llm.spent())} / budget ${fmt$(budget)}`);
  if (llm.stopped) {
    console.log("STOPPED: budget guard reached");
    process.exitCode = 3;
  }
  const after = readResults();
  const all = cells.filter((c) => isDone(after.get(c.cell_key)));
  console.log(`stage progress: ${all.length}/${cells.length} done, pass ${all.filter((c) => after.get(c.cell_key).pass).length}`);
  fs.mkdirSync(path.join(BENCH_DIR, "runs"), { recursive: true });
  fs.appendFileSync(
    path.join(BENCH_DIR, "runs", "process-log.jsonl"),
    JSON.stringify({ cmd: regrade ? "regrade" : "run", stage, at: new Date().toISOString(), pid: process.pid, finished: doneN, ...s, spent_now: llm.spentNow, stopped: llm.stopped }) + "\n",
  );
}

// ---------------------------------------------------------------- status
function status() {
  const m = manifest();
  const results = readResults();
  const known = new Set();
  for (const stage of Object.keys(m.stages)) {
    let cells;
    try {
      cells = expandStage(stage, { m });
    } catch (e) {
      console.log(`${stage}: ${e.message}`);
      continue;
    }
    cells.forEach((c) => known.add(c.cell_key));
    const done = cells.filter((c) => isDone(results.get(c.cell_key)));
    const infra = cells.filter((c) => results.get(c.cell_key)?.status === "infra_error").length;
    console.log(`${stage}: ${done.length}/${cells.length} done, pass ${done.filter((c) => results.get(c.cell_key).pass).length}, infra_error ${infra}`);
  }
  const stale = [...results.keys()].filter((k) => !known.has(k)).length;
  console.log(`result rows not matched by the current manifest (stale versions): ${stale}`);
  const ledger = readLedger();
  const byStage = {};
  for (const l of ledger) byStage[l.stage] = (byStage[l.stage] ?? 0) + l.cost_usd;
  console.log(`ledger: ${ledger.length} requests; spend by stage ${JSON.stringify(Object.fromEntries(Object.entries(byStage).map(([k, v]) => [k, +v.toFixed(5)])))}`);
  const keys = ledger.map((l) => l.llm_key);
  console.log(`duplicate llm_keys in ledger (paid twice): ${keys.length - new Set(keys).size}`);
}

// ---------------------------------------------------------------- selfcheck
// Replay every done cell twice from cache (offline) and check that the message
// sequence (llm_keys) matches the stored row both times (BENCH.md §4.4).
async function selfcheck(stage) {
  const { m, tasks, cells } = selectCells(stage);
  const results = readResults();
  let ok = 0;
  let bad = 0;
  for (const cell of cells) {
    const row = results.get(cell.cell_key);
    if (!isDone(row)) continue;
    const keys = [];
    for (let i = 0; i < 2; i++) {
      const llm = new LlmClient({ stage, budgetUsd: 0, offline: true });
      try {
        const ep = await runEpisode({ cell, task: tasks.get(cell.task_id), params: m.params, llm });
        keys.push(ep.turns.map((t) => t.llm_key).join(","));
      } catch (e) {
        keys.push(`ERR ${e.message}`);
      }
    }
    const stored = row.turns.map((t) => t.llm_key).join(",");
    if (keys[0] === stored && keys[1] === stored) ok++;
    else {
      bad++;
      console.log(`MISMATCH ${cell.task_id} ${cell.model} ${cell.lang}: ${keys.map((k) => k.slice(0, 40)).join(" | ")}`);
    }
  }
  console.log(`selfcheck ${stage}: ${ok} deterministic, ${bad} mismatched`);
  if (bad) process.exitCode = 1;
}

// ---------------------------------------------------------------- check-tasks
function checkTasks() {
  const tasks = loadTasks();
  let bad = 0;
  for (const t of tasks.values()) {
    let ref;
    try {
      ref = computeReference(t);
    } catch (e) {
      console.log(`${t.id}: PRECONDITION FAILED ${e.message}`);
      bad++;
      continue;
    }
    if (!ref.has) {
      console.log(`${t.id}: no reference value (compare ${t.expect.answer.compare}); preconditions ok`);
      continue;
    }
    const frozen = t.expect.answer.value;
    if (frozen === "FILLED_BY_SCRIPT") {
      if (opt.write) {
        const file = path.join(BENCH_DIR, t.file);
        const text = fs.readFileSync(file, "utf8").replace("value: FILLED_BY_SCRIPT", `value: ${JSON.stringify(ref.value)}`);
        fs.writeFileSync(file, text);
        console.log(`${t.id}: wrote ${JSON.stringify(ref.value).slice(0, 120)}`);
      } else console.log(`${t.id}: not frozen yet; computed ${JSON.stringify(ref.value).slice(0, 160)} (use --write)`);
      continue;
    }
    if (canonicalJson(frozen) === canonicalJson(ref.value)) console.log(`${t.id}: ok`);
    else {
      bad++;
      console.log(`${t.id}: MISMATCH frozen ${JSON.stringify(frozen).slice(0, 120)} vs computed ${JSON.stringify(ref.value).slice(0, 120)}`);
    }
  }
  if (bad) process.exitCode = 1;
}

// ---------------------------------------------------------------- main
const HELP = `usage: node harness/cli.js <command> [--stage smoke]
  plan          dry-run: pending cells per (model, lang), cost estimate, budget (no requests)
  run           run pending cells (--budget N lowers the cap, --offline never sends,
                --only <substr> filters cells, --concurrency N, --max-cells N, --dry-run = plan)
  status        completion per stage, stale rows, ledger spend, duplicate requests
  regrade       replay done cells from cache (offline) and append re-graded rows
  selfcheck     replay done cells twice offline; llm_keys must match the stored rows
  check-tasks   recompute reference answers / preconditions (--write fills placeholders)
  ping          connection test: one tiny request per model`;

switch (cmd) {
  case "plan":
    plan(opt.stage);
    break;
  case "run":
    await run(opt.stage);
    break;
  case "regrade":
    await run(opt.stage, { regrade: true });
    break;
  case "status":
    status();
    break;
  case "selfcheck":
    await selfcheck(opt.stage);
    break;
  case "check-tasks":
    checkTasks();
    break;
  case "ping": {
    const { ping } = await import("./ping.js");
    await ping();
    break;
  }
  default:
    console.log(HELP);
}
