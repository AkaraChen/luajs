// API key loading. The key lives only in this module's closure: it is never
// returned to callers, logged, cached or written anywhere.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const keys = new Map();

function load(provider) {
  if (keys.has(provider.id)) return keys.get(provider.id);
  let key = provider.key_env ? process.env[provider.key_env] : undefined;
  if (!key) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".eta/config.json"), "utf8"));
      key = cfg.providers?.find((p) => p.id === provider.eta_provider_id)?.apiKey;
    } catch {
      /* fall through */
    }
  }
  if (!key) throw new Error(`no API key for provider ${provider.id}: set ${provider.key_env} or configure eta`);
  keys.set(provider.id, key);
  return key;
}

/** Headers for a request. Callers must not persist the returned object. */
export function authHeaders(provider) {
  return { Authorization: `Bearer ${load(provider)}` };
}

/** Remove any occurrence of a loaded key from a string (for error messages). */
export function redact(s) {
  let out = String(s);
  for (const k of keys.values()) {
    if (!k) continue;
    out = out.split(k).join("***");
    for (let i = 0; i + 8 <= k.length; i += 4) out = out.split(k.slice(i, i + 8)).join("***");
  }
  return out;
}
