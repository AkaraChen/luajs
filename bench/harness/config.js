import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { BENCH_DIR } from "./util.js";

export const loadYaml = (p) => YAML.parse(fs.readFileSync(p, "utf8"));
export const manifest = () => loadYaml(path.join(BENCH_DIR, "manifest.yaml"));
export const pricing = () => loadYaml(path.join(BENCH_DIR, "harness/pricing.yaml"));
export const models = () => loadYaml(path.join(BENCH_DIR, "harness/models.yaml"));
