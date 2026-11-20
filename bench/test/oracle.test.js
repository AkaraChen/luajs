// End-to-end episode + grading tests with a scripted fake LLM (no model calls).
// Each script is a list of turns; a turn is either {code} (a run call) or {text}.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTasks } from "../harness/cells.js";
import { manifest } from "../harness/config.js";
import { runEpisode } from "../harness/episode.js";
import { LlmClient } from "../harness/llm/client.js";

const tasks = loadTasks();
const params = manifest().params;

class FakeLlm {
  constructor(script) {
    this.script = script;
    this.i = 0;
    this.seen = [];
  }
  async complete({ model, messages, params: p, sample }) {
    this.seen.push(messages.map((m) => m.content));
    const step = this.script[this.i++] ?? { text: "done" };
    const message = step.code
      ? { role: "assistant", content: "", tool_calls: [{ id: `call_${this.i}`, type: "function", function: { name: "run", arguments: JSON.stringify({ code: step.code }) } }] }
      : { role: "assistant", content: step.text };
    const response = { choices: [{ message, finish_reason: step.code ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } };
    return { llm_key: LlmClient.key({ model, messages, params: p, sample }), cache_hit: false, response, usage: { input: 100, cached_input: 0, output: 10, reasoning: 0 }, cost_usd: 0 };
  }
}

async function episode(taskId, lang, script) {
  const cell = { task_id: taskId, model: "fake", lang, repeat: 0, cell_key: "k".repeat(64) };
  return runEpisode({ cell, task: tasks.get(taskId), params, llm: new FakeLlm(script) });
}

const CASES = [
  // [task, lang, script, expectPass, expectTag]
  ["c1-issue-assignee-01", "lua-interim", [{ code: "local i = issues.get{id = 42}\nreturn i.assignee and i.assignee.login" }], true],
  ["c1-issue-assignee-01", "lua-interim", [{ code: "issues.get{id = 42}.assignee.login" }, { text: "出错了" }], false, "no_answer(nil_null)"],
  ["c1-issue-assignee-01", "js", [{ code: "const i = await issues.get({id: 42});\ni.assignee?.login ?? null" }], true],
  ["c1-issue-assignee-01", "js", [{ code: "const i = await issues.get({id: 42});\ni.assignee?.login" }], false, "no_answer"],
  [
    "c2-top-customers-01",
    "lua-interim",
    [
      {
        code: `local orders = orders.search{since = "2026-02-01T00:00:00Z", before = "2026-03-01T00:00:00Z"}
local tot = {}
for i = 1, #orders do
  local o = orders[i]
  if o.status ~= "cancelled" then tot[o.customer_id] = (tot[o.customer_id] or 0) + o.amount end
end
local rows = {}
for id, t in pairs(tot) do rows[#rows + 1] = {customer_id = id, total = t} end
table.sort(rows, function(a, b) return a.total > b.total end)
local top = {}
for i = 1, 5 do top[i] = rows[i] end
top`,
      },
    ],
    true,
  ],
  [
    "c2-top-customers-01",
    "js",
    [
      {
        code: `const os = await orders.search({since: "2026-02-01T00:00:00Z", before: "2026-03-01T00:00:00Z"});
const tot = {};
for (const o of os) if (o.status !== "cancelled") tot[o.customer_id] = (tot[o.customer_id] ?? 0) + o.amount;
Object.entries(tot).map(([k, v]) => ({customer_id: Number(k), total: Math.round(v * 100) / 100})).sort((a, b) => b.total - a.total).slice(0, 5)`,
      },
    ],
    true,
  ],
  [
    "c3-refundable-fanout-01",
    "lua-interim",
    [{ code: "local os = orders.search{customer_id = 10234}\nlocal out = array()\nfor i = 1, #os do\n  local o = orders.get{id = os[i].id}\n  if o.refundable then out[#out + 1] = o.id end\nend\nout" }],
    true,
  ],
  [
    "c3-refundable-fanout-01",
    "js",
    [{ code: "const os = await orders.search({customer_id: 10234});\nconst ds = await Promise.all(os.map(o => orders.get({id: o.id})));\nds.filter(d => d.refundable).map(d => d.id)" }],
    true,
  ],
  ["c4-refund-expired-01", "js", [{ code: "const o = await orders.get({id: 1001});\no.refundable" }, { text: "该订单已超过 7 天退货期，不能退款。" }], true],
  ["c4-refund-expired-01", "lua-interim", [{ code: 'orders.refund{id = 1001, reason = "不想要了"}' }], false, "wrong_side_effect"],
  ["c5-truncate-zh-01", "lua-interim", [{ code: 'local f = fs.read{path = "docs/公告.md"}\nf.content:sub(1, 50)' }], false, "utf8"],
  ["c5-truncate-zh-01", "lua-interim", [{ code: 'local s = fs.read{path = "docs/公告.md"}.content\nlocal j = utf8.offset(s, 51)\nreturn j and s:sub(1, j - 1) or s' }], true],
  ["c5-truncate-zh-01", "js", [{ code: 'const f = await fs.read({path: "docs/公告.md"});\nArray.from(f.content).slice(0, 50).join("")' }], true],
  ["c6-clear-labels-01", "lua-interim", [{ code: 'users.set_labels{id = "u_17", labels = {}}' }], true],
  ["c6-clear-labels-01", "lua-interim", [{ code: 'users.set_labels{id = "u_17", labels = array()}' }], true],
  ["c6-clear-labels-01", "js", [{ code: 'await users.set_labels({id: "u_17", labels: []})' }], true],
  ["c6-clear-labels-01", "js", [{ code: 'await users.set_labels({id: "u_17", labels: {}})' }], false, "wrong_side_effect"],
  ["c7-rate-limited-01", "lua-interim", [{ code: 'users.get{id = "u_5"}.email' }, { code: 'users.get{id = "u_5"}.email' }], true],
  ["c7-rate-limited-01", "js", [{ code: 'let u;\nfor (let i = 0; i < 3 && !u; i++) { try { u = await users.get({id: "u_5"}) } catch (e) {} }\nu.email' }], true],
  ["c7-rate-limited-01", "js", [{ code: 'while (true) { try { await users.get({id: "u_5"}) } catch (e) {} }' }], false, "wrong_side_effect"],
  ["c7-rate-limited-01", "lua-interim", [{ code: 'while true do pcall(users.get, {id = "u_5"}) end' }], false, "wrong_side_effect"],
  ["c8-issue-title-01", "lua-interim", [{ code: "issues.get{id = 7}" }, { text: "标题是 Search ignores accents" }], true],
  ["c8-issue-title-01", "js", [{ code: "(await issues.get({id: 7})).title" }], true],
];

for (const [taskId, lang, script, expectPass, expectTag] of CASES) {
  test(`${taskId} ${lang} ${expectPass ? "pass" : `fail(${expectTag})`}: ${JSON.stringify(script[0]).slice(9, 60)}`, async () => {
    const ep = await episode(taskId, lang, script);
    assert.equal(ep.pass, expectPass, JSON.stringify({ why: ep.why, runs: ep.runs.map((r) => r.text) }, null, 1));
    if (expectTag) assert.equal(ep.fail_tag, expectTag);
  });
}

test("fan-out classification", async () => {
  const seq = await episode("c3-refundable-fanout-01", "lua-interim", [CASES[6][2][0]]);
  assert.deepEqual(seq.fanout, ["sequential_loop"]);
  const conc = await episode("c3-refundable-fanout-01", "js", [CASES[7][2][0]]);
  assert.deepEqual(conc.fanout, ["concurrent"]);
});

test("max_turns: 4th turn's run is executed and graded, no 5th request", async () => {
  const llm = new FakeLlm(Array(6).fill({ code: "issues.get{id = 7}.title" }));
  const cell = { task_id: "c8-issue-title-01", model: "fake", lang: "lua-interim", repeat: 0, cell_key: "k".repeat(64) };
  const ep = await runEpisode({ cell, task: tasks.get("c8-issue-title-01"), params, llm });
  assert.equal(llm.i, 4);
  assert.equal(ep.runs.length, 4);
  assert.equal(ep.ended, "max_turns");
});
