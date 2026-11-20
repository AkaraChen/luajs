// JS runtime: approximates eta's ESM codemode on node:vm.
// - fresh context per run (no globals survive); `state` survives via JSON
// - last top-level expression is the result (acorn rewrite to `return (...)`)
// - tools are async functions; failures throw an Error with kind/tool/message/data
// - no require/import/process/timers/fetch; eval & new Function disabled
// - budget: an AST tick guard (__tick() at every loop body and function entry,
//   inserted without adding lines) plus a vm timeout for the synchronous part.
//   (vm `timeout` + microtaskMode "afterEvaluate" aborts Node when the timeout
//   fires inside a microtask, so microtasks drain on the normal queue instead.)
import vm from "node:vm";
import * as acorn from "acorn";

const TIMEOUT_MS = 5000;
const MAX_TICKS = 5_000_000;
const MAX_LOG_LINES = 200;

const BOOTSTRAP = `
"use strict";
(() => {
  const host = globalThis.__host, log = globalThis.__log, scopes = JSON.parse(globalThis.__scopes);
  const budget = globalThis.__budget, max = globalThis.__maxTicks;
  delete globalThis.__host; delete globalThis.__log; delete globalThis.__scopes; delete globalThis.__budget; delete globalThis.__maxTicks;
  // Determinism: the clock is frozen at the mock world's "now", Math.random is seeded.
  const RealDate = Date, FIXED = RealDate.parse(globalThis.__now);
  delete globalThis.__now;
  class Date_ extends RealDate {
    constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
    static now() { return FIXED; }
  }
  Object.defineProperty(Date_, "name", { value: "Date" });
  globalThis.Date = Date_;
  let seed = 0x9e3779b9;
  Math.random = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let ticks = 0;
  let dead = false; // sticky: once the budget trips, every tick / tool call throws again
  const trip = (msg) => { dead = true; budget(); throw new RangeError(msg); };
  Object.defineProperty(globalThis, "__tick", { enumerable: false, value: () => {
    if (dead || ++ticks > max) trip("budget exceeded (instruction limit)");
  } });
  const lineOf = (stack) => { const m = /run\\.js:(\\d+):\\d+/.exec(String(stack)); return m ? Number(m[1]) : null; };
  for (const [scope, fns] of Object.entries(scopes)) {
    const t = {};
    for (const fn of fns) {
      const name = scope + "." + fn;
      t[fn] = async function (args) {
        if (dead) trip("budget exceeded");
        const line = lineOf(new Error().stack);
        let json;
        try { json = JSON.stringify(args === undefined ? {} : args); }
        catch (e) { throw new TypeError(name + ": arguments are not JSON-serializable: " + e.message); }
        const res = JSON.parse(host(name, json === undefined ? "null" : json, line));
        if (res.ok) return res.value;
        if (res.error.kind === "budget") trip(res.error.message);
        const err = new Error(res.error.message);
        err.name = "ToolError";
        err.kind = res.error.kind; err.tool = res.error.tool;
        if (res.error.data !== undefined) err.data = res.error.data;
        throw err;
      };
    }
    Object.freeze(t);
    Object.defineProperty(globalThis, scope, { value: t, writable: false, enumerable: true });
  }
  const fmt = (v) => typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  globalThis.console = Object.freeze({ log: (...a) => log(a.map(fmt).join(" ")), error: (...a) => log(a.map(fmt).join(" ")), warn: (...a) => log(a.map(fmt).join(" ")), info: (...a) => log(a.map(fmt).join(" ")) });
})();
`;

const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const FUNCS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * Rewrite user code without changing line numbers:
 *  - the last top-level expression statement becomes `return (...)`
 *  - __tick() at the start of every loop body and function body
 */
export function prepareJs(code) {
  let ast;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    });
  } catch (e) {
    const line = e.loc?.line ?? null;
    return { syntax: { message: `run:${line ?? "?"}: ${String(e.message).replace(/ \(\d+:\d+\)$/, "")}`, line } };
  }
  const ins = []; // {pos, text, open: bool, depth}
  const wrap = (node, open, close, depth) => {
    ins.push({ pos: node.start, text: open, open: true, depth });
    ins.push({ pos: node.end, text: close, open: false, depth });
  };
  const visit = (node, depth) => {
    if (!node || typeof node.type !== "string") return;
    if (LOOPS.has(node.type)) {
      const b = node.body;
      if (b.type === "BlockStatement") ins.push({ pos: b.start + 1, text: "__tick();", open: true, depth: depth + 1 });
      else wrap(b, "{__tick();", "}", depth + 1);
    } else if (FUNCS.has(node.type)) {
      const b = node.body;
      if (b.type === "BlockStatement") ins.push({ pos: b.start + 1, text: "__tick();", open: true, depth: depth + 1 });
      else wrap(b, "(__tick(), ", ")", depth + 1);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "loc") continue;
      if (Array.isArray(v)) v.forEach((c) => visit(c, depth + 1));
      else if (v && typeof v === "object" && typeof v.type === "string") visit(v, depth + 1);
    }
  };
  visit(ast, 0);
  const last = ast.body[ast.body.length - 1];
  if (last && last.type === "ExpressionStatement" && !last.directive) wrap(last.expression, "return (", ")", -1);
  // Apply from the end. At equal positions: closings before openings textually;
  // among closings inner first; among openings outer first.
  ins.sort((a, b) => b.pos - a.pos || (a.open === b.open ? (a.open ? b.depth - a.depth : a.depth - b.depth) : a.open ? -1 : 1));
  let body = code;
  for (const i of ins) body = body.slice(0, i.pos) + i.text + body.slice(i.pos);
  return { body };
}

function toJsonValue(v, seen = new Set()) {
  if (v === null) return null;
  switch (typeof v) {
    case "number":
      return Number.isFinite(v) ? v : String(v);
    case "string":
    case "boolean":
      return v;
    case "undefined":
      return null;
    case "bigint":
      return String(v);
    case "function":
      return "<function>";
    case "symbol":
      return "<symbol>";
  }
  if (seen.has(v)) return "<cycle>";
  seen.add(v);
  let out;
  if (typeof v.toJSON === "function") out = toJsonValue(v.toJSON(), seen);
  else if (Array.isArray(v)) {
    out = []; // build in this realm (v.map would create a context-realm array)
    for (let i = 0; i < v.length; i++) out.push(toJsonValue(v[i], seen));
  }
  else if (v instanceof Map || Object.prototype.toString.call(v) === "[object Map]") out = Object.fromEntries([...v].map(([k, x]) => [String(k), toJsonValue(x, seen)]));
  else if (Object.prototype.toString.call(v) === "[object Set]") out = Array.from(v, (x) => toJsonValue(x, seen));
  else {
    out = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) out[k] = toJsonValue(v[k], seen);
  }
  seen.delete(v);
  return out;
}

export async function createJsRuntime({ host }) {
  const scopes = {};
  for (const name of host.tools()) {
    const [scope, fn] = name.split(".");
    (scopes[scope] ??= []).push(fn);
  }
  let stateJson = "{}";

  return {
    lang: "js",
    async run(code) {
      const effects = [];
      const logs = [];
      const warnings = [];
      const prep = prepareJs(code);
      if (prep.syntax) return { status: "syntax", error: prep.syntax, logs, warnings, effects, committed: { set: [], delete: [] } };

      const sandbox = {
        __host: (name, json, line) => {
          const before = host.effects.length;
          const r = host.call(name, JSON.parse(json), line);
          effects.push(...host.effects.slice(before));
          return JSON.stringify(r);
        },
        __log: (s) => {
          if (logs.length < MAX_LOG_LINES) logs.push(String(s));
        },
        __scopes: JSON.stringify(scopes),
        __budget: () => {
          exhausted = true;
        },
        __maxTicks: MAX_TICKS,
        __now: host.state.now,
      };
      let exhausted = false;
      const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
      vm.runInContext(BOOTSTRAP, ctx, { filename: "bootstrap.js" });
      const stateBefore = JSON.parse(stateJson);
      vm.runInContext(`globalThis.state = JSON.parse(${JSON.stringify(stateJson)});`, ctx);

      let settled = null;
      ctx.__settle = (ok, v) => {
        settled = { ok, v };
      };
      const src = `"use strict"; (async () => {\n${prep.body}\n})().then((v) => __settle(true, v), (e) => __settle(false, e));`;
      let status = "ok";
      let error;
      try {
        new vm.Script(src, { filename: "run.js", lineOffset: -1 }).runInContext(ctx, { timeout: TIMEOUT_MS });
      } catch (e) {
        if (String(e?.message).includes("Script execution timed out")) {
          status = "budget";
          error = { message: `budget exceeded (time limit ${TIMEOUT_MS} ms)` };
        } else {
          status = "error";
          error = { message: String(e?.message ?? e) };
        }
      }
      // Tool promises resolve synchronously; let the microtask queue drain.
      for (let i = 0; i < 3 && !settled && status === "ok"; i++) await new Promise((r) => setImmediate(r));
      let value;
      let has_value = false;
      if (exhausted) {
        status = "budget";
        error = { message: "budget exceeded (instruction limit)" };
      } else if (status === "ok") {
        if (!settled) {
          status = "error";
          error = { message: "run did not finish: it awaited something that never resolves (there are no timers or I/O in this sandbox)" };
        } else if (settled.ok) {
          has_value = settled.v !== undefined;
          if (has_value) value = toJsonValue(settled.v);
        } else {
          const e = settled.v;
          status = "error";
          const isObj = e !== null && typeof e === "object";
          const m = isObj ? /run\.js:(\d+):\d+/.exec(String(e.stack)) : null;
          error = {
            message: isObj && "message" in e ? `${e.name ?? "Error"}: ${e.message}` : `Uncaught ${String(e)}`,
            line: m ? Number(m[1]) : null,
          };
          if (isObj && e.kind && e.tool) Object.assign(error, { kind: e.kind, tool: e.tool, data: e.data });
        }
      }
      // state commit (top-level key diff), regardless of status
      let stateAfter = stateBefore;
      try {
        const s = ctx.state;
        stateAfter = s && typeof s === "object" ? toJsonValue(s) : {};
      } catch (e) {
        warnings.push(`state: ${e.message}`);
      }
      const committed = { set: [], delete: [] };
      for (const k of Object.keys(stateAfter)) if (JSON.stringify(stateAfter[k]) !== JSON.stringify(stateBefore[k])) committed.set.push(k);
      for (const k of Object.keys(stateBefore)) if (!(k in stateAfter)) committed.delete.push(k);
      committed.set.sort();
      committed.delete.sort();
      stateJson = JSON.stringify(stateAfter);
      return { status, has_value, value, error, logs, warnings, effects, committed };
    },
    dispose() {},
  };
}
