// Connection test: one tiny request per model (stage "ping" in the ledger).
import { LlmClient } from "./llm/client.js";
import { manifest } from "./config.js";

export async function ping(modelsArg) {
  const m = manifest();
  const client = new LlmClient({ stage: "ping", budgetUsd: 0.05 });
  const params = {
    temperature: m.params.temperature,
    max_tokens: 2000,
    tools: [
      {
        type: "function",
        function: {
          name: "run",
          description: "Run code.",
          parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
        },
      },
    ],
  };
  for (const model of modelsArg ?? m.models) {
    try {
      const r = await client.complete({
        model,
        messages: [{ role: "user", content: "Call the run tool with code 1+1." }],
        params,
        sample: "ping",
        meta: { session: "luajs-bench-ping" },
      });
      const msg = r.response.choices[0].message;
      const fields = ["reasoning_content", "reasoning"].filter((k) => msg[k]).join(",") || "none";
      console.log(
        `${model}: ok cache_hit=${r.cache_hit} finish=${r.response.choices[0].finish_reason} ` +
          `tool_calls=${JSON.stringify(msg.tool_calls?.map((c) => c.function))} reasoning_field=${fields} ` +
          `usage=${JSON.stringify(r.response.usage)} cost=$${r.cost_usd.toFixed(6)}`,
      );
    } catch (e) {
      console.log(`${model}: FAILED ${e.message}`);
    }
  }
  console.log(`requests=${client.stats.requests} cache_hits=${client.stats.cache_hits}`);
}
