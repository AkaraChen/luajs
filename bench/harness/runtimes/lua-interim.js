// lua-interim runtime: wasmoon (Lua 5.4) + prelude.lua approximating the luajs
// surface. One engine per episode; locals never survive between runs, `state`
// does (JSON round trip, top-level key diff).
import fs from "node:fs";
import path from "node:path";
import { LuaFactory } from "wasmoon";
import { TOOLS } from "../../tasks/mock/index.js";

const PRELUDE = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "lua/prelude.lua"), "utf8");
let factory;

export async function createLuaRuntime({ host, scopes }) {
  factory ??= new LuaFactory();
  const lua = await factory.createEngine({ injectObjects: false, enableProxy: false, traceAllocations: true });
  lua.global.setMemoryMax(256 * 1024 * 1024);

  const scopeSchemas = {};
  for (const name of host.tools()) {
    const [scope, fn] = name.split(".");
    (scopeSchemas[scope] ??= {})[fn] = TOOLS[name].input;
  }
  let runEffects = [];
  lua.global.set("__host_call", (name, argsJson, line) => {
    let args;
    try {
      args = JSON.parse(argsJson);
    } catch {
      args = argsJson;
    }
    const before = host.effects.length;
    const r = host.call(name, args, typeof line === "number" ? line : null);
    runEffects.push(...host.effects.slice(before));
    return JSON.stringify(r);
  });
  lua.global.set("__scopes_json", JSON.stringify(scopeSchemas));
  lua.doStringSync(PRELUDE);
  const runFn = lua.global.get("__run");
  let stateJson = "{}";

  return {
    lang: "lua-interim",
    run(code) {
      runEffects = [];
      let out;
      try {
        out = runFn(code, stateJson);
      } catch (e) {
        // Escaped the prelude's xpcall (should not happen) or engine trap.
        return { status: "crashed", error: { message: String(e?.message ?? e) }, logs: [], warnings: [], effects: runEffects, committed: { set: [], delete: [] } };
      }
      const [resJson, valueJson, newState] = String(out).split("\n");
      const res = JSON.parse(resJson);
      stateJson = newState;
      return {
        status: res.status,
        has_value: !!res.has_value,
        value: res.has_value ? JSON.parse(valueJson) : undefined,
        error: res.error,
        logs: res.logs ?? [],
        warnings: res.warnings ?? [],
        effects: runEffects,
        committed: res.committed ?? { set: [], delete: [] },
      };
    },
    dispose() {
      lua.global.close();
    },
  };
}
