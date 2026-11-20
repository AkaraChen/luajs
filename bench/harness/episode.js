// One episode = one cell: single user instruction, one `run` tool, at most
// max_turns model replies (BENCH.md §2.2). Everything sent to the model is
// deterministic given the cached responses, so a replay reproduces the exact
// same messages (and therefore the same llm_keys).
import { buildWorld, ToolHost } from "../tasks/mock/index.js";
import { deepClone, hashOf } from "./util.js";
import { createJsRuntime } from "./runtimes/js.js";
import { createLuaRuntime } from "./runtimes/lua-interim.js";
import { systemPrompt } from "./surface/rules.js";
import { runToolSpec, formatResult } from "./surface/surface.js";
import { grade } from "./grade/grade.js";
import { tagRun, tagEpisode, classifyFanout } from "./grade/classify.js";

const RUNTIMES = { js: createJsRuntime, "lua-interim": createLuaRuntime };

/** Keep only fields that belong in the conversation history. */
function historyMessage(msg) {
  const m = { role: "assistant", content: msg.content ?? "" };
  if (msg.reasoning_content) m.reasoning_content = msg.reasoning_content;
  if (msg.tool_calls?.length)
    m.tool_calls = msg.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.function?.name, arguments: c.function?.arguments ?? "" } }));
  return m;
}

export function requestParams(manifestParams, lang, scopes, host) {
  return {
    tools: [runToolSpec(lang, host.tools())],
    temperature: manifestParams.temperature,
    max_tokens: manifestParams.max_tokens,
  };
}

export async function runEpisode({ cell, task, params, llm, log = () => {} }) {
  const before = buildWorld(task.mock);
  const host = new ToolHost({ state: deepClone(before), scopes: task.scopes, faults: task.mock.faults ?? [] });
  const rt = await RUNTIMES[cell.lang]({ host, scopes: task.scopes });
  const reqParams = requestParams(params, cell.lang, task.scopes, host);
  const messages = [
    { role: "system", content: systemPrompt(cell.lang) },
    { role: "user", content: task.instruction.trim() },
  ];
  const turns = [];
  const runs = [];
  const usage = { input: 0, cached_input: 0, output: 0, reasoning: 0 };
  let cost = 0;
  let finalText = null;
  let ended = "no_tool_call";
  const session = `luajs-bench-${cell.cell_key.slice(0, 24)}`;

  try {
    for (let turn = 1; turn <= params.max_turns; turn++) {
      const r = await llm.complete({
        model: cell.model,
        messages,
        params: reqParams,
        sample: cell.repeat,
        meta: { cell: cell.cell_key, turn, session },
      });
      for (const k of Object.keys(usage)) usage[k] += r.usage?.[k] ?? 0;
      cost += r.cost_usd ?? 0;
      const choice = r.response.choices?.[0] ?? {};
      const msg = choice.message ?? {};
      const hist = historyMessage(msg);
      messages.push(hist);
      const t = {
        turn,
        llm_key: r.llm_key,
        cache_hit: r.cache_hit,
        messages_hash: hashOf(messages.slice(0, -1)),
        finish_reason: choice.finish_reason ?? null,
        content: msg.content ?? "",
        reasoning_chars: (msg.reasoning_content ?? "").length,
        usage: r.usage,
        cost_usd: r.cost_usd,
        runs: [],
      };
      turns.push(t);
      if (!hist.tool_calls?.length) {
        finalText = msg.content ?? "";
        ended = choice.finish_reason === "length" ? "length" : "answered";
        break;
      }
      for (const call of hist.tool_calls) {
        let text;
        let code = null;
        if (call.function.name !== "run") {
          text = `error: unknown tool ${call.function.name}; the only tool is run`;
          runs.push({ status: "invalid_call", code: null, error: { message: text } });
        } else {
          try {
            const args = JSON.parse(call.function.arguments || "{}");
            code = typeof args.code === "string" ? args.code : null;
          } catch {
            code = null;
          }
          if (code === null) {
            text = 'error: invalid arguments for run; expected {"code": "<source>"}';
            runs.push({ status: "invalid_call", code: null, error: { message: text } });
          } else {
            host.beginRun(runs.length);
            const res = await rt.run(code);
            text = formatResult(res, cell.lang, code);
            runs.push({ ...res, code, text });
          }
        }
        const run = runs[runs.length - 1];
        run.turn = turn;
        run.error_tag = tagRun(run, cell.lang);
        t.runs.push(runs.length - 1);
        messages.push({ role: "tool", tool_call_id: call.id, content: text });
      }
      if (turn === params.max_turns) ended = "max_turns";
    }
  } finally {
    rt.dispose();
  }

  const g = grade(task, { runs, effects: host.effects, before, after: host.state, finalText });
  const fffd = g.answer.has && JSON.stringify(g.answer.value).includes("�");
  return {
    turns,
    runs: runs.map((r) => ({
      turn: r.turn,
      status: r.status,
      error_tag: r.error_tag,
      code: r.code,
      has_value: r.has_value ?? false,
      value: r.value,
      error: r.error,
      effects: (r.effects ?? []).map((e) => ({ tool: e.tool, args: e.args, status: e.status, line: e.line })),
      text: r.text,
    })),
    final_text: finalText,
    ended,
    pass: g.pass,
    checks: g.checks,
    why: g.why,
    answer: g.answer,
    state_diff: g.diff,
    effects_total: host.effects.length,
    fail_tag: tagEpisode(g, runs, fffd),
    fanout: task.observe === "fanout" ? classifyFanout(runs, cell.lang) : undefined,
    usage,
    cost_usd: cost,
    n_turns: turns.length,
  };
}
