// World registry + patch application (C6-style data patches, BENCH.md §1.2).
import { generateWorld, WORLD, MOCK_VERSION, ToolHost, TOOLS } from "./world.js";
import { ptrSet, ptrDelete, deepClone } from "../../harness/util.js";

export const WORLDS = { [WORLD]: { generate: generateWorld, mock_version: MOCK_VERSION } };
export { ToolHost, TOOLS };

const cache = new Map();

/** Initial state for a task's mock spec (deep copy; episodes never share state). */
export function buildWorld(mock) {
  const w = WORLDS[mock.world];
  if (!w) throw new Error(`unknown mock world ${mock.world}`);
  if (mock.mock_version !== w.mock_version)
    throw new Error(`task wants ${mock.world} mock_version ${mock.mock_version}, implementation is ${w.mock_version}`);
  const key = JSON.stringify([mock.world, mock.seed, mock.patches ?? []]);
  if (!cache.has(key)) {
    const st = w.generate(mock.seed);
    for (const p of mock.patches ?? []) {
      if (p.op === "set") ptrSet(st, p.path, deepClone(p.value));
      else if (p.op === "delete") ptrDelete(st, p.path);
      else throw new Error(`unknown patch op ${p.op}`);
    }
    cache.set(key, JSON.stringify(st));
  }
  return JSON.parse(cache.get(key));
}
