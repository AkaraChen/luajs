// Runtime behaviour tests (no model calls): node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, ToolHost } from "../tasks/mock/index.js";
import { createLuaRuntime } from "../harness/runtimes/lua-interim.js";
import { createJsRuntime } from "../harness/runtimes/js.js";
import { formatResult } from "../harness/surface/surface.js";

const MOCK = { world: "core-v1", mock_version: 1, seed: 4217, patches: [{ op: "set", path: "/issues/42/assignee", value: null }] };
const ALL = ["issues", "orders", "users", "fs", "time"];

async function lua(faults = []) {
  const host = new ToolHost({ state: buildWorld(MOCK), scopes: ALL, faults });
  return { host, rt: await createLuaRuntime({ host, scopes: ALL }) };
}
async function js(faults = []) {
  const host = new ToolHost({ state: buildWorld(MOCK), scopes: ALL, faults });
  return { host, rt: await createJsRuntime({ host, scopes: ALL }) };
}

test("lua: last expression is the result, multi-line", async () => {
  const { rt } = await lua();
  assert.deepEqual((await rt.run("local x = 1\nlocal y = 2\nx + y")).value, 3);
  assert.deepEqual((await rt.run("1 + 1")).value, 2);
  assert.deepEqual((await rt.run("local t = {}\nfor i = 1, 3 do t[#t+1] = i end\nreturn t")).value, [1, 2, 3]);
  assert.deepEqual((await rt.run("local t = {\n  a = 1,\n}\nt")).value, { a: 1 });
  const r = await rt.run("local x = 1\nif x then\n  x = 2\nend");
  assert.equal(r.status, "ok");
  assert.equal(r.has_value, false);
});

test("lua: strict globals and disabled libs", async () => {
  const { rt } = await lua();
  const r = await rt.run("x = 1");
  assert.equal(r.status, "error");
  assert.match(r.error.message, /cannot assign global 'x'/);
  assert.match((await rt.run("os.time()")).error.message, /'os' is not available/);
  assert.match((await rt.run("coroutine.wrap(function() end)")).error.message, /'coroutine' is not available/);
  assert.match((await rt.run("string.dump(print)")).error.message, /attempt to call a nil value/);
  assert.match((await rt.run("setmetatable({}, {})")).error.message, /not available/);
  assert.match((await rt.run("JSON.parse('1')")).error.message, /undefined global 'JSON'/);
});

test("lua: tools are synchronous, null -> nil, numeric keys stay strings", async () => {
  const { rt } = await lua();
  const r = await rt.run("local i = issues.get{id = 42}\nreturn i.assignee == nil, math.type(i.id)");
  assert.deepEqual(r.value, [true, "integer"]);
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].line, 1);
  assert.match((await rt.run("issues.get{id = 42}.assignee.login")).error.message, /attempt to index a nil value/);
});

test("lua: tool error is a structured table, pcall works, effects line", async () => {
  const { rt } = await lua([{ tool: "users.get", times: 1, error: { message: "rate limited", data: { code: "rate_limited" } } }]);
  const r = await rt.run('local ok, e = pcall(users.get, {id = "u_5"})\nlocal ok2, u = pcall(users.get, {id = "u_5"})\nreturn {ok, e.kind, e.data.code, ok2, u.email}');
  assert.deepEqual(r.value, [false, "tool_failed", "rate_limited", true, "user5@example.com"]);
  assert.deepEqual(r.effects.map((e) => [e.status, e.line]), [["failed", 1], ["ok", 2]]);
});

test("lua: uncaught tool error reports kind and line", async () => {
  const { rt } = await lua();
  const r = await rt.run('local a = 1\nlocal u = users.get{id = "nope"}\nu');
  assert.equal(r.status, "error");
  assert.equal(r.error.kind, "tool_failed");
  assert.equal(r.error.line, 2);
  const text = formatResult(r, "lua-interim", 'local a = 1\nlocal u = users.get{id = "nope"}\nu');
  assert.match(text, /effects \(not rolled back\):\n  \[failed\] users.get id="nope" \(line 2\)/);
});

test("lua: empty table encodes per schema for tool args, {} elsewhere, array() for []", async () => {
  const { rt, host } = await lua();
  await rt.run('users.set_labels{id = "u_17", labels = {}}');
  assert.deepEqual(host.state.users.u_17.labels, []);
  assert.deepEqual((await rt.run("{}")).value, {});
  assert.deepEqual((await rt.run("array()")).value, []);
  const arr = await rt.run('local o = orders.get{id = 1001}\nreturn #o.items, o.items');
  assert.equal(arr.value[0], arr.value[1].length);
});

test("lua: byte truncation produces U+FFFD, utf8.offset does not", async () => {
  const { rt } = await lua();
  assert.equal((await rt.run('string.sub("中文字", 1, 4)')).value, "中�");
  assert.equal((await rt.run('local s = "中文字"\nreturn s:sub(1, utf8.offset(s, 3) - 1)')).value, "中文");
});

test("lua: budget, pcall cannot swallow it", async () => {
  const { rt } = await lua();
  const r = await rt.run("while true do pcall(function() while true do end end) end");
  assert.equal(r.status, "budget");
});

test("lua: state survives across runs, locals do not", async () => {
  const { rt } = await lua();
  const r1 = await rt.run("local a = 5\nstate.n = 7\nreturn a");
  assert.deepEqual(r1.committed.set, ["n"]);
  assert.equal((await rt.run("state.n")).value, 7);
  assert.match((await rt.run("a")).error.message, /undefined global 'a'/);
});

test("lua: syntax error has line", async () => {
  const { rt } = await lua();
  const r = await rt.run("local x = 1\nif x != 2 then\nend");
  assert.equal(r.status, "syntax");
  assert.equal(r.error.line, 2);
  assert.match(formatResult(r, "lua-interim", "local x = 1\nif x != 2 then\nend"), /hint: 不等于用 ~=/);
});

test("lua: pairs order is deterministic across engines", async () => {
  const code = 'local t = {}\nfor _, k in ipairs({"b","a","zz","c1","q"}) do t[k] = true end\nlocal o = {}\nfor k in pairs(t) do o[#o+1] = k end\nreturn o';
  const a = (await lua()).rt.run(code).value;
  const b = (await lua()).rt.run(code).value;
  assert.deepEqual(a, b);
});

test("js: last expression, async tools, null, strict", async () => {
  const { rt } = await js();
  assert.equal((await rt.run("const i = await issues.get({id: 42})\ni.assignee")).value, null);
  assert.equal((await rt.run("1 + 1")).value, 2);
  const r = await rt.run("x = 1");
  assert.equal(r.status, "error");
  assert.match(r.error.message, /x is not defined/);
  assert.match((await rt.run("require('fs')")).error.message, /require is not defined/);
  assert.match((await rt.run("eval('1')")).error.message, /Code generation from strings disallowed|EvalError/);
});

test("js: tool error shape, line, effects", async () => {
  const { rt } = await js([{ tool: "users.get", times: 1, error: { message: "rate limited", data: { code: "rate_limited" } } }]);
  const code = "let out\ntry { await users.get({id: 'u_5'}) } catch (e) { out = [e.kind, e.tool, e.data.code] }\nconst u = await users.get({id: 'u_5'});\n[...out, u.email]";
  const r = await rt.run(code);
  assert.deepEqual(r.value, ["tool_failed", "users.get", "rate_limited", "user5@example.com"]);
  assert.deepEqual(r.effects.map((e) => [e.status, e.line]), [["failed", 2], ["ok", 3]]);
  const r2 = await rt.run("const a = 1\nawait users.get({id: 'nope'})");
  assert.equal(r2.error.line, 2);
  assert.equal(r2.error.kind, "tool_failed");
});

test("js: infinite loop hits budget", async () => {
  const { rt } = await js();
  assert.equal((await rt.run("while (true) {}")).status, "budget");
  assert.equal((await rt.run("await issues.get({id: 1}); while (true) {}")).status, "budget");
});

test("js: never-resolving await is reported", async () => {
  const { rt } = await js();
  const r = await rt.run("await new Promise(() => {})");
  assert.equal(r.status, "error");
  assert.match(r.error.message, /never resolves/);
});

test("js: clock is frozen at the mock now, Math.random is seeded", async () => {
  const { rt } = await js();
  assert.equal((await rt.run("new Date().toISOString()")).value, "2026-03-15T10:00:00.000Z");
  assert.equal((await rt.run("Date.now()")).value, Date.parse("2026-03-15T10:00:00Z"));
  assert.equal((await rt.run("new Date('2026-02-01').getTime()")).value, Date.parse("2026-02-01"));
  const a = (await rt.run("Math.random()")).value;
  assert.equal((await rt.run("Math.random()")).value, a);
});
