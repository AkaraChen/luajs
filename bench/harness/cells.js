// Tasks, cell expansion, result store and version fingerprints (BENCH.md §4.1–4.3, §4.7).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { BENCH_DIR, RUNS_DIR, hashOf, sha256, readJsonl, appendJsonlLine, writeFileAtomic } from "./util.js";
import { WORLDS } from "../tasks/mock/index.js";
import { manifest } from "./config.js";
import { staticRules, systemPrompt, RULES } from "./surface/rules.js";

export const RESULTS_DIR = path.join(RUNS_DIR, "results");

export function loadTasks() {
  const dir = path.join(BENCH_DIR, "tasks");
  const out = new Map();
  for (const cat of fs.readdirSync(dir).filter((d) => /^C\d+$/.test(d)).sort()) {
    for (const f of fs.readdirSync(path.join(dir, cat)).filter((f) => f.endsWith(".yaml")).sort()) {
      const file = path.join(dir, cat, f);
      const text = fs.readFileSync(file, "utf8");
      const t = YAML.parse(text);
      t.file = path.relative(BENCH_DIR, file);
      t.content_hash = sha256(text);
      t.task_version = `${t.version}+m${t.mock.mock_version}`;
      if (out.has(t.id)) throw new Error(`duplicate task id ${t.id}`);
      out.set(t.id, t);
    }
  }
  return out;
}

export function harnessVersion(m, lang) {
  const hv = m.harness_version;
  if (hv[lang] === undefined) throw new Error(`manifest.harness_version has no entry for ${lang}`);
  return `${hv.common}.${hv[lang]}`;
}

export function cellKey(c) {
  return hashOf({
    task_id: c.task_id,
    task_version: c.task_version,
    model: c.model,
    lang: c.lang,
    harness_version: c.harness_version,
    repeat: c.repeat,
  });
}

export function expandStage(stageName, { m = manifest(), tasks = loadTasks() } = {}) {
  const st = m.stages[stageName];
  if (!st) throw new Error(`unknown stage ${stageName}`);
  let ids;
  if (Array.isArray(st.tasks)) ids = st.tasks;
  else if (st.tasks === "all") ids = [...tasks.keys()];
  else if (/^per_category:\d+$/.test(st.tasks)) {
    const n = Number(st.tasks.split(":")[1]);
    const byCat = new Map();
    for (const t of tasks.values()) {
      const l = byCat.get(t.category) ?? [];
      if (l.length < n) l.push(t.id);
      byCat.set(t.category, l);
    }
    ids = [...byCat.values()].flat();
  } else throw new Error(`unsupported tasks selector ${st.tasks}`);
  const cells = [];
  for (const id of ids) {
    const t = tasks.get(id);
    if (!t) throw new Error(`stage ${stageName} references unknown task ${id}`);
    for (const model of st.models ?? m.models)
      for (const lang of st.langs)
        for (let repeat = 0; repeat < st.repeats; repeat++) {
          const c = { task_id: id, task_version: t.task_version, model, lang, harness_version: harnessVersion(m, lang), repeat };
          cells.push({ ...c, cell_key: cellKey(c) });
        }
  }
  return cells;
}

export const resultFile = (model, lang) => path.join(RESULTS_DIR, `${model}.${lang}.jsonl`);

/** All result rows (last row per cell_key wins). */
export function readResults() {
  const rows = new Map();
  if (!fs.existsSync(RESULTS_DIR)) return rows;
  for (const f of fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".jsonl")).sort())
    for (const r of readJsonl(path.join(RESULTS_DIR, f))) rows.set(r.cell_key, r);
  return rows;
}

export const isDone = (row) => row?.status === "done";

export function writeResult(row) {
  appendJsonlLine(resultFile(row.model, row.lang), row);
}

// ---------------------------------------------------------------- fingerprints
const read = (rel) => fs.readFileSync(path.join(BENCH_DIR, rel), "utf8");

/**
 * Content hashes of everything a version number vouches for. If content changed
 * but the version did not, refuse to run (BENCH.md §4.7).
 * Grading code is deliberately excluded (use `regrade`).
 */
export function fingerprints(m, tasks, langs) {
  const fp = {};
  fp[`common@${m.harness_version.common}`] = sha256(
    JSON.stringify({ params: m.params, rules: RULES, sys: langs.map(systemPrompt) }) +
      read("harness/surface/surface.js") +
      read("harness/episode.js"),
  );
  for (const lang of langs) {
    const files = lang === "js" ? ["harness/runtimes/js.js"] : ["harness/runtimes/lua-interim.js", "harness/runtimes/lua/prelude.lua"];
    fp[`${lang}@${m.harness_version[lang]}`] = sha256(staticRules(lang) + files.map(read).join("\n"));
  }
  for (const [name, w] of Object.entries(WORLDS)) fp[`mock:${name}@${w.mock_version}`] = sha256(read("tasks/mock/world.js") + read("tasks/mock/index.js"));
  for (const t of tasks) fp[`task:${t.id}@${t.version}`] = t.content_hash;
  return fp;
}

const FP_FILE = path.join(RUNS_DIR, "fingerprints.json");

export function checkFingerprints(current, { record }) {
  const known = fs.existsSync(FP_FILE) ? JSON.parse(fs.readFileSync(FP_FILE, "utf8")) : {};
  const stale = Object.entries(current).filter(([k, h]) => known[k] && known[k] !== h).map(([k]) => k);
  if (!stale.length && record) writeFileAtomic(FP_FILE, JSON.stringify({ ...known, ...current }, null, 2));
  return stale;
}
