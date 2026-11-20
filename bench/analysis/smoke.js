#!/usr/bin/env node
// Markdown tables for the smoke report, read-only over runs/ (no model calls).
//   node analysis/smoke.js [--stage smoke] [--episodes]   (--episodes also dumps every episode's code/results)
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { manifest } from "../harness/config.js";
import { expandStage, readResults, isDone, loadTasks } from "../harness/cells.js";
import { readLedger } from "../harness/llm/client.js";
import { BENCH_DIR } from "../harness/util.js";

const { values: opt } = parseArgs({ options: { stage: { type: "string", default: "smoke" }, episodes: { type: "boolean", default: false } } });
const m = manifest();
const tasks = loadTasks();
const cells = expandStage(opt.stage, { m, tasks });
const results = readResults();
const rows = cells.map((c) => results.get(c.cell_key)).filter(isDone);
const ledger = readLedger();
const $ = (x, d = 4) => `$${x.toFixed(d)}`;
const short = { "deepseek-v4.1-flash": "deepseek", "glm-5.3": "glm", "qwen3.8-flash": "qwen" };
const out = [];
const p = (s = "") => out.push(s);

p(`## 汇总`);
p();
p(`完成 ${rows.length}/${cells.length} 格；严格判分通过 ${rows.filter((r) => r.pass).length}，宽松判分通过 ${rows.filter((r) => r.pass_lenient).length}。`);
p();
p(`| 模型 | 语言 | 严格通过 | 宽松通过 | 平均轮数 | 输入 tok | 其中缓存 | 输出 tok | 其中思考 | 费用 |`);
p(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
for (const model of m.models)
  for (const lang of m.stages[opt.stage].langs) {
    const rs = rows.filter((r) => r.model === model && r.lang === lang);
    if (!rs.length) continue;
    const sum = (f) => rs.reduce((s, r) => s + f(r), 0);
    p(
      `| ${model} | ${lang} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${rs.filter((r) => r.pass_lenient).length}/${rs.length} | ${(sum((r) => r.n_turns) / rs.length).toFixed(2)} | ${sum((r) => r.usage.input)} | ${sum((r) => r.usage.cached_input)} | ${sum((r) => r.usage.output)} | ${sum((r) => r.usage.reasoning)} | ${$(sum((r) => r.cost_usd))} |`,
    );
  }
p();

p(`## 逐 episode`);
p();
p(`| # | 题 | 模型 | 语言 | 严格 | 宽松 | 轮数 | runs（状态/标签） | 输入/输出 tok | 费用 | 失败标签 | 判分说明 |`);
p(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
let i = 0;
for (const r of [...rows].sort((a, b) => a.task_id.localeCompare(b.task_id) || a.model.localeCompare(b.model) || a.lang.localeCompare(b.lang))) {
  i++;
  const runs = r.runs.map((x) => (x.status === "ok" ? "ok" : `${x.status}:${x.error_tag}`)).join(", ") || "—";
  const why = Object.values(r.why ?? {}).filter(Boolean).join("; ").replace(/\|/g, "\\|").slice(0, 140);
  p(
    `| ${i} | ${r.task_id.replace(/-01$/, "")} | ${short[r.model] ?? r.model} | ${r.lang === "js" ? "js" : "lua"} | ${r.pass ? "✅" : "❌"} | ${r.pass_lenient ? "✅" : "❌"}${r.lenient_via ? ` (${r.lenient_via})` : ""} | ${r.n_turns} | ${runs} | ${r.usage.input}/${r.usage.output} | ${$(r.cost_usd)} | ${r.fail_tag ?? ""} | ${why} |`,
  );
}
p();

p(`## 扇出写法（C3）`);
p();
p(`| 模型 | 语言 | 写法 | orders.get 调用数 | 严格 | 宽松 |`);
p(`| --- | --- | --- | --- | --- | --- |`);
for (const r of rows.filter((r) => r.fanout)) {
  const gets = r.runs.flatMap((x) => x.effects).filter((e) => e.tool === "orders.get").length;
  p(`| ${r.model} | ${r.lang} | ${r.fanout.join(" + ") || "（未识别）"} | ${gets} | ${r.pass ? "✅" : "❌"} | ${r.pass_lenient ? "✅" : "❌"} |`);
}
p();

p(`## 错误标签（失败的 run）`);
p();
const tagCount = new Map();
for (const r of rows) for (const x of r.runs) if (x.error_tag) tagCount.set(`${r.lang === "js" ? "js" : "lua"} ${x.error_tag}`, (tagCount.get(`${r.lang === "js" ? "js" : "lua"} ${x.error_tag}`) ?? 0) + 1);
p(`| 语言 | 标签 | 次数 |`);
p(`| --- | --- | --- |`);
for (const [k, n] of [...tagCount].sort()) p(`| ${k.split(" ")[0]} | ${k.split(" ")[1]} | ${n} |`);
p();

p(`## 费用`);
p();
const stageLedger = ledger.filter((l) => l.stage === opt.stage);
const total = stageLedger.reduce((s, l) => s + l.cost_usd, 0);
const keys = stageLedger.map((l) => l.llm_key);
p(`- 账本中 ${opt.stage} 阶段真实请求 ${stageLedger.length} 个，合计 ${$(total)}；重复的 llm_key（重复付费）${keys.length - new Set(keys).size} 个。`);
p(`- 按结果行累计的 episode 费用合计 ${$(rows.reduce((s, r) => s + r.cost_usd, 0))}（每个请求只计一次，含被杀进程里已付费、续跑时命中缓存的请求）。`);
p();
p(`| 模型 | episode 数 | 平均每 episode | 平均输入 tok | 平均输出 tok | full 估算（720 episode/模型） |`);
p(`| --- | --- | --- | --- | --- | --- |`);
let fullTotal = 0;
for (const model of m.models) {
  const rs = rows.filter((r) => r.model === model);
  if (!rs.length) continue;
  const avg = rs.reduce((s, r) => s + r.cost_usd, 0) / rs.length;
  fullTotal += avg * 720;
  p(`| ${model} | ${rs.length} | ${$(avg, 5)} | ${Math.round(rs.reduce((s, r) => s + r.usage.input, 0) / rs.length)} | ${Math.round(rs.reduce((s, r) => s + r.usage.output, 0) / rs.length)} | ${$(avg * 720, 2)} |`);
}
p(`| **合计** | | | | | **${$(fullTotal, 2)}** |`);
p();

const plog = path.join(BENCH_DIR, "runs", "process-log.jsonl");
if (fs.existsSync(plog)) {
  p(`## 进程记录（runs/process-log.jsonl）`);
  p();
  p("```");
  p(fs.readFileSync(plog, "utf8").trim());
  p("```");
}

if (opt.episodes) {
  p();
  p(`## 附：逐 episode 代码与结果`);
  for (const r of [...rows].sort((a, b) => a.task_id.localeCompare(b.task_id) || a.model.localeCompare(b.model) || a.lang.localeCompare(b.lang))) {
    p();
    p(`### ${r.task_id} · ${r.model} · ${r.lang} · ${r.pass ? "PASS" : "FAIL"} (${r.fail_tag ?? ""})`);
    p(`checks ${JSON.stringify(r.checks)} why ${JSON.stringify(r.why)}`);
    for (const x of r.runs) {
      p(`--- run (turn ${x.turn}) status=${x.status} tag=${x.error_tag}`);
      p(x.code ?? "(no code)");
      p(`>>> ${(x.text ?? "").slice(0, 600)}`);
    }
    p(`final: ${(r.final_text ?? "").slice(0, 400)}`);
  }
}
console.log(out.join("\n"));
