// Signatures (ARCHITECTURE.md §10.3 style) and the run tool spec, plus
// formatResult (§9.6) shared by both languages.
import { TOOLS } from "../../tasks/mock/index.js";
import { staticRules, HINTS, LANG_NAME } from "./rules.js";

function typeStr(s, lang) {
  if (!s) return "any";
  if (s.anyOf) return s.anyOf.map((x) => typeStr(x, lang)).join(" | ");
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join("|");
  const t = s.type;
  if (Array.isArray(t)) return t.map((x) => typeStr({ ...s, type: x }, lang)).join(" | ");
  switch (t) {
    case "integer":
      return lang === "js" ? "number" : "integer";
    case "number":
    case "string":
    case "boolean":
    case "null":
      return t;
    case "array": {
      const inner = typeStr(s.items, lang);
      return /[ |]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
    }
    case "object": {
      const req = new Set(s.required ?? []);
      const props = Object.entries(s.properties ?? {}).map(([k, v]) => `${k}${req.has(k) || !s.required?.length ? "" : "?"}: ${typeStr(v, lang)}`);
      return `{${props.join(", ")}}`;
    }
    default:
      return "any";
  }
}

function argsStr(s, lang) {
  const req = new Set(s.required ?? []);
  const props = Object.entries(s.properties ?? {}).map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${typeStr(v, lang)}`);
  return `{${props.join(", ")}}`;
}

export function signature(name, lang) {
  const t = TOOLS[name];
  const out = t.output ? typeStr(t.output, lang) : "any";
  const args = argsStr(t.input, lang);
  const sig = lang === "js" ? `await ${name}(${args}): ${out}` : `${name}${args} -> ${out}`;
  return `${sig}\n    ${lang === "js" ? "//" : "--"} ${t.description}`;
}

export function runToolSpec(lang, toolNames) {
  const desc =
    `执行一段 ${LANG_NAME[lang]} 代码，返回结果、日志和 tool 调用记录。\n\n` +
    `规则：\n${staticRules(lang)}\n\n` +
    `可用的 tool：\n${toolNames.map((n) => signature(n, lang)).join("\n")}`;
  return {
    type: "function",
    function: {
      name: "run",
      description: desc,
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: `${LANG_NAME[lang]} 代码` } },
        required: ["code"],
      },
    },
  };
}

// ---------------------------------------------------------------- formatResult
const MAX_VALUE_CHARS = 4000;
const MAX_LOG_TAIL = 20;

function stable(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stable);
  const o = {};
  for (const k of Object.keys(v).sort()) o[k] = stable(v[k]);
  return o;
}

function renderArgs(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return JSON.stringify(args);
  const s = Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join(" ");
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}

export function hintFor(lang, message, code, line) {
  const src = line ? code.split("\n")[line - 1] : undefined;
  const table = HINTS[lang === "js" ? "js" : "lua"];
  const h = table.find((h) => h.test(message ?? "", code, src));
  return h ? { id: h.id, hint: h.hint } : null;
}

/** RunResult -> text for the model. Deterministic (no timings). */
export function formatResult(r, lang, code) {
  const out = [];
  if (r.status === "ok") {
    if (!r.has_value) out.push("(no value)");
    else {
      let s = JSON.stringify(stable(r.value), null, 2);
      if (s.length > MAX_VALUE_CHARS) s = s.slice(0, MAX_VALUE_CHARS) + `\n… (truncated, ${s.length} chars total)`;
      out.push(`value: ${s}`);
    }
  } else {
    const e = r.error ?? {};
    const label = r.status === "syntax" ? "syntax error" : r.status === "budget" ? "budget" : "error";
    let msg = e.message ?? "unknown error";
    if (e.line && !/^run:\d+:/.test(msg)) msg = `run:${e.line}: ${msg}`;
    out.push(`${label}: ${msg}`);
    if (e.kind && e.data !== undefined) out.push(`  data: ${JSON.stringify(stable(e.data))}`);
    const src = e.line ? code.split("\n")[e.line - 1] : undefined;
    if (src !== undefined) out.push(`  ${e.line} | ${src.trim()}`);
    const h = hintFor(lang, e.message, code, e.line);
    if (h) out.push(`  hint: ${h.hint}`);
  }
  if (r.warnings?.length) {
    out.push("", "warnings:");
    for (const w of r.warnings.slice(0, 20)) out.push(`  ${w}`);
  }
  if (r.logs?.length) {
    const tail = r.logs.slice(-MAX_LOG_TAIL);
    out.push("", r.logs.length > MAX_LOG_TAIL ? `logs (last ${MAX_LOG_TAIL} of ${r.logs.length}):` : "logs:");
    for (const l of tail) out.push(`  ${l.length > 300 ? l.slice(0, 300) + "…" : l}`);
  }
  if (r.effects?.length) {
    out.push("", r.status === "ok" ? "effects:" : "effects (not rolled back):");
    const shown = r.effects.slice(0, 50);
    for (const ef of shown) {
      const prefix = ef.status === "ok" ? "" : `[${ef.status}] `;
      out.push(`  ${prefix}${ef.tool} ${renderArgs(ef.args)}${ef.line ? ` (line ${ef.line})` : ""}`);
    }
    if (r.effects.length > shown.length) out.push(`  … ${r.effects.length - shown.length} more`);
  }
  if (r.committed?.set?.length || r.committed?.delete?.length) {
    out.push("", `state committed: ${[...(r.committed.set ?? []), ...(r.committed.delete ?? []).map((k) => `-${k}`)].join(", ")}`);
  }
  return out.join("\n");
}
