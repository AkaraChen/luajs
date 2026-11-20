// Shared helpers: canonical JSON, hashing, JSONL I/O, atomic writes.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Canonical JSON: object keys sorted, no whitespace, UTF-8. Used for every hash. */
export function canonicalJson(v) {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) return JSON.stringify(String(v));
    return JSON.stringify(v === undefined ? null : v);
  }
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

export function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

export const hashOf = (v) => sha256(canonicalJson(v));

/** Stable pretty JSON (sorted keys) for text shown to models. */
export function stableStringify(v, indent = 2) {
  const sort = (x) => {
    if (x === null || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map(sort);
    const o = {};
    for (const k of Object.keys(x).sort()) o[k] = sort(x[k]);
    return o;
  };
  return JSON.stringify(sort(v), null, indent);
}

export function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Read a JSONL file, tolerating a truncated last line (crash mid-write). */
export function readJsonl(file, { warn = console.warn } = {}) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line));
    } catch {
      if (i >= lines.length - 2) warn(`[warn] ${file}: dropping incomplete last line`);
      else warn(`[warn] ${file}:${i + 1}: unparsable line skipped`);
    }
  });
  return out;
}

/** Append one complete line with a single write + fsync (O_APPEND). */
export function appendJsonlLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.from(JSON.stringify(obj) + "\n", "utf8");
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Write via temp file + rename so readers never see a partial file. */
export function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export const BENCH_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const RUNS_DIR = process.env.BENCH_RUNS_DIR
  ? path.resolve(process.env.BENCH_RUNS_DIR)
  : path.join(BENCH_DIR, "runs");

/** JSON Pointer helpers (RFC 6901). */
export const ptrEscape = (k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");
export const ptrUnescape = (k) => k.replace(/~1/g, "/").replace(/~0/g, "~");
export function ptrParts(ptr) {
  if (ptr === "" || ptr === "/") return [];
  return ptr.split("/").slice(1).map(ptrUnescape);
}
export function ptrSet(obj, ptr, value) {
  const parts = ptrParts(ptr);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
export function ptrDelete(obj, ptr) {
  const parts = ptrParts(ptr);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]];
    if (cur == null) return;
  }
  delete cur[parts[parts.length - 1]];
}
