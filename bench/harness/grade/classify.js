// Rule-based error tags (BENCH.md §3.2) and fan-out style observation (C3).

/** Tag one failed run. */
export function tagRun(run, lang) {
  if (run.status === "ok") return null;
  if (run.status === "syntax") {
    if (lang !== "js" && jsIsm(run.code)) return "js_ism";
    return "syntax";
  }
  if (run.status === "budget") return "budget";
  if (run.status === "invalid_call") return "invalid_call";
  const m = run.error?.message ?? "";
  if (run.error?.kind) return "tool_error_unhandled";
  // a local named like a tool scope shadows it: `local orders = orders.search{}` then orders.get -> nil;
  // JS: `const orders = await orders.search()` -> TDZ ReferenceError
  if (/Cannot access '(\w+)' before initialization/.test(m) || (/attempt to call a nil value \(field '\w+'\)/.test(m) && /local\s+(\w+)\s*=\s*\1\./.test(run.code ?? ""))) return "scope_shadow";
  if (/Unexpected token 'return'/.test(m)) return "harness_rewrite_bug";
  if (lang !== "js" && jsIsm(run.code) && /arithmetic on a string|attempt to (get length|index|call)/.test(m)) return "js_ism";
  if (/undefined global|is not available in this sandbox|is not defined|is not a function|attempt to call a nil value/.test(m)) return "unknown_api";
  if (/attempt to index a nil value|Cannot read properties of (null|undefined)/.test(m)) return "nil_null";
  if (/attempt to compare|attempt to concatenate|attempt to perform arithmetic|number has no integer representation|bad argument/.test(m)) return "type";
  if (/cannot assign global/.test(m)) return "global_write";
  return "unknown";
}

function jsIsm(code = "") {
  const stripped = code.replace(/--\[\[[\s\S]*?\]\]|--[^\n]*/g, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  return /!=|===|\.length\b|\bconst\b|\blet\b|=>|\bawait\b|\bconsole\./.test(stripped) || /\+\s*""|""\s*\+/.test(stripped);
}

/** Episode-level primary failure tag. */
export function tagEpisode(g, runs, finalAnswerHasFffd) {
  if (g.pass) return null;
  if (!g.checks.state_diff || !g.checks.effects) return "wrong_side_effect";
  if (finalAnswerHasFffd) return "utf8";
  if (!g.answer.has) {
    const lastFail = [...runs].reverse().find((r) => r.status !== "ok");
    return lastFail?.error_tag ? `no_answer(${lastFail.error_tag})` : "no_answer";
  }
  return "wrong_answer";
}

/**
 * Fan-out style for observe: fanout tasks. Looks at every submitted run.
 *  sequential_loop: tool call inside a loop, awaited / called one by one
 *  concurrent:      Promise.all / allSettled over tool calls (JS)
 *  coroutine:       attempted coroutine (Lua) / parallel()
 *  batch:           single call with many ids (e.g. ids = {...})
 *  unrolled:        many literal calls written out by hand
 */
export function classifyFanout(runs, lang) {
  const styles = new Set();
  for (const r of runs) {
    const c = r.code ?? "";
    if (lang === "js") {
      if (/Promise\.(all|allSettled|race|any)\s*\(/.test(c)) styles.add("concurrent");
      if (/\b(for|while)\b[\s\S]*?await\s+orders\.get/.test(c) || /for\s*\([^)]*\)\s*\{[^}]*await\s+orders\.get/.test(c)) {
        if (!/Promise\.(all|allSettled)/.test(c)) styles.add("sequential_loop");
      }
    } else {
      if (/\bcoroutine\b/.test(c)) styles.add("coroutine");
      if (/\bparallel\b/.test(c)) styles.add("parallel");
      if (/\b(for|while|repeat)\b[\s\S]*orders\.get/.test(c)) styles.add("sequential_loop");
    }
    if (/orders\.get\s*[({]\s*\{?\s*ids\s*[=:]/.test(c)) styles.add("batch");
    if ((c.match(/orders\.get\s*[({]/g) ?? []).length >= 5) styles.add("unrolled");
  }
  return [...styles].sort();
}
