// Grading (BENCH.md §1.4): final answer + mock state diff + effects, all
// accumulated over the whole episode (failed runs are not rolled back).
// Grading logic is NOT part of harness_version: change it and `bench regrade`.
import { canonicalJson, ptrEscape } from "../util.js";

// ---------------------------------------------------------------- answer
function looseEqual(a, b, opt, path = "$") {
  if (opt.numeric_tol !== undefined && typeof a === "number" && typeof b === "number")
    return Math.abs(a - b) <= opt.numeric_tol ? null : `${path}: ${a} != ${b}`;
  if (opt.loose_numeric_strings && (typeof a === "number" || typeof b === "number") && (typeof a === "string" || typeof b === "string"))
    return String(a) === String(b) ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object")
    return a === b ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const e = looseEqual(a[i], b[i], opt, `${path}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (canonicalJson(ka) !== canonicalJson(kb)) return `${path}: keys ${ka.join(",")} != ${kb.join(",")}`;
  for (const k of ka) {
    const e = looseEqual(a[k], b[k], opt, `${path}.${k}`);
    if (e) return e;
  }
  return null;
}

export function checkAnswer(spec, answer, finalText) {
  const { compare, value, options = {} } = spec;
  if (compare === "any") return { ok: true };
  if (compare === "mentions") {
    const hay = `${answer.has ? JSON.stringify(answer.value) : ""}\n${finalText ?? ""}`;
    return hay.includes(value) ? { ok: true } : { ok: false, why: `expected text ${JSON.stringify(value)} not found` };
  }
  if (!answer.has) return { ok: false, why: "no successful run returned a value" };
  if (compare === "json_equal") {
    const e = looseEqual(answer.value, value, options);
    return e ? { ok: false, why: e } : { ok: true };
  }
  if (compare === "text_exact") {
    if (typeof answer.value !== "string") return { ok: false, why: `expected a string, got ${JSON.stringify(answer.value)?.slice(0, 80)}` };
    return answer.value.trim() === value.trim() ? { ok: true } : { ok: false, why: `text differs: ${JSON.stringify(answer.value.slice(0, 80))}` };
  }
  if (compare === "set_equal") {
    const A = new Set((answer.value ?? []).map(canonicalJson));
    const B = new Set(value.map(canonicalJson));
    const ok = A.size === B.size && [...A].every((x) => B.has(x));
    return ok ? { ok } : { ok, why: "sets differ" };
  }
  throw new Error(`unknown compare ${compare}`);
}

// ---------------------------------------------------------------- state diff
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Diff by JSON Pointer; arrays and scalars are leaves. */
export function stateDiff(before, after, path = "", out = { set: {}, delete: [] }) {
  if (isObj(before) && isObj(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const p = `${path}/${ptrEscape(k)}`;
      if (!(k in after)) out.delete.push(p);
      else if (!(k in before)) out.set[p] = after[k];
      else stateDiff(before[k], after[k], p, out);
    }
  } else if (canonicalJson(before) !== canonicalJson(after)) {
    out.set[path] = after;
  }
  out.delete.sort();
  return out;
}

export function checkState(expected, actual) {
  const exp = { set: expected?.set ?? {}, delete: [...(expected?.delete ?? [])].sort() };
  const ok = canonicalJson(exp) === canonicalJson(actual);
  return ok ? { ok } : { ok, why: `state diff ${canonicalJson(actual).slice(0, 300)} != expected ${canonicalJson(exp).slice(0, 200)}` };
}

// ---------------------------------------------------------------- effects
export function checkEffects(spec = {}, effects) {
  const names = effects.map((e) => e.tool);
  const why = [];
  for (const t of spec.must_call ?? []) if (!names.includes(t)) why.push(`missing call ${t}`);
  for (const t of spec.must_not_call ?? []) if (names.includes(t)) why.push(`forbidden call ${t}`);
  if (spec.max_calls !== undefined && names.length > spec.max_calls) why.push(`${names.length} calls > max ${spec.max_calls}`);
  for (const rule of spec.order ?? []) {
    const [a, b] = rule.split("<").map((x) => x.trim());
    const ia = names.indexOf(a);
    const ib = names.indexOf(b);
    if (ib !== -1 && (ia === -1 || ia > ib)) why.push(`order violated: ${rule}`);
  }
  return why.length ? { ok: false, why: why.join("; ") } : { ok: true };
}

/**
 * The answer is the value of the last successful run that produced a value
 * (a trailing ok run with no value, e.g. a print-only check, does not erase it).
 */
export function pickAnswer(runs) {
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.status === "ok" && r.has_value) return { has: true, value: r.value, run_index: i };
  }
  return { has: false };
}

export function grade(task, { runs, effects, before, after, finalText }) {
  const answer = pickAnswer(runs);
  const a = checkAnswer(task.expect.answer, answer, finalText);
  const diff = stateDiff(before, after);
  const s = checkState(task.expect.state_diff, diff);
  const e = checkEffects(task.expect.effects, effects);
  return {
    pass: a.ok && s.ok && e.ok,
    checks: { answer: a.ok, state_diff: s.ok, effects: e.ok },
    why: { answer: a.why, state_diff: s.why, effects: e.why },
    answer,
    diff,
  };
}
