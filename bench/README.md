# bench — luajs codemode 评测框架

设计见仓库根目录 [BENCH.md](../BENCH.md)，运行时 surface 规则见 [ARCHITECTURE.md](../ARCHITECTURE.md)。
本目录是它的第一版实现：mock 世界、题目、harness（两种语言的运行时、surface、LLM 缓存 / 账本 / 预算、判分）和 CLI。

> luajs 本体还不存在，Lua 组目前用 **lua-interim**（wasmoon，Lua 5.4 wasm + `harness/runtimes/lua/prelude.lua` 模拟 luajs 的 surface）。
> 它的结果单独标为 `lua-interim`，cell key 也不同，不会和将来 luajs 的结果混用。

## 快速开始

```sh
cd bench
bun install                 # 或 npm install：wasmoon、yaml、acorn
node --test test/*.test.js  # 运行时 + 判分测试，不调用模型
node harness/cli.js plan    # dry-run：待跑格子数、预估费用、预算余量（不发请求）
node harness/cli.js run --stage smoke
node harness/cli.js status
```

### API key

模型走 opencode go 的 OpenAI 兼容接口（`harness/models.yaml`）。key 按顺序取：

1. 环境变量 `OPENCODE_API_KEY`；
2. `~/.eta/config.json` 里 `providers` 中 `id` 为 `opencode-go` 那一项的 `apiKey`。

key 只在 `harness/llm/secrets.js` 的内存里使用：不进缓存、账本、结果、日志；缓存只存请求体和响应体，不存 header。
请求头里另带 `x-opencode-session`（每个 episode 一个稳定的 id，opencode go 要求）和 `User-Agent: luajs-bench/0.1`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `plan [--stage s]` | dry-run：每个 (model, lang) 的待跑格子数、预估费用（有已完成 episode 时用实测均值）、账本已花费、预算余量 |
| `run [--stage s]` | 跑未完成的格子。`--budget N` 只能调低 manifest 的上限；`--offline` 缓存未命中即报错、不发请求；`--only <子串>` 过滤格子（匹配 `task/model/lang/repeat`，可重复）；`--concurrency N`；`--max-cells N`；`--dry-run` 等于 `plan` |
| `status` | 各 stage 完成度、过期结果行数、账本花费、账本里重复的 llm_key 数（= 重复付费的请求数） |
| `regrade [--stage s]` | 只改了判分逻辑时：离线用缓存重放已完成格子并追加重新判分的结果行，不花钱 |
| `selfcheck [--stage s]` | 确定性自检：每个已完成格子离线重放两次，llm_key 序列必须与结果行一致 |
| `check-tasks [--write]` | 用 `tasks/reference.js` 对 mock 世界重新计算参考答案并与题目文件里固化的值比较；`--write` 填充 `FILLED_BY_SCRIPT` 占位 |
| `ping` | 连接测试：每个模型发一个极小的请求（账本 stage 记为 `ping`） |

## 断点恢复与不重复花钱（BENCH.md §4）

- **格子**：`cell_key = sha256(canonical_json({task_id, task_version, model, lang, harness_version, repeat}))`，
  `task_version = "<题目 version>+m<mock_version>"`，`harness_version = "<common>.<lang>"`（见 `manifest.yaml`）。stage 不进 key。
- **结果**：`runs/results/<model>.<lang>.jsonl`，一个格子跑完、判完分才一次 `write` + `fsync` 追加一整行；读取时丢弃不完整的末行；
  同一 key 多行取最后一行；`infra_error` 行不算完成。
- **请求缓存**：`llm_key = sha256(canonical_json({model, messages, params, sample: repeat}))`，`params` 是除 model / messages 外发给 API 的全部字段（tools、temperature、max_tokens）。
  文件 `runs/cache/llm/<前 2 位>/<llm_key>.json`（临时文件 + rename），只缓存完整成功的响应。
  mock 世界和运行时输出是确定性的（JS 组的 `Date` 冻结在 mock 的 now、`Math.random` 有固定种子；Lua 组的 `pairs` 顺序确定），
  所以中断的格子重跑时，前面各轮的 messages 完全相同 → 命中缓存 → 只有中断点之后才发新请求。
- **账本**：每个真实请求追加一行到 `runs/ledger.jsonl`（llm_key、stage、model、usage、费用、时间，不含任何密钥）。
  费用优先用 provider 在 `usage.opencode.list_cost` 里给出的标价，没有时按 `harness/pricing.yaml` 计算。
- **预算护栏**：每次发请求前检查 `账本中本 stage 已花 + 进行中请求的最坏费用 + 本请求最坏费用 > 上限` 就不再发请求、不再开始新格子，
  进行中的格子就地放弃（不写结果行，已发出的请求都已缓存），退出码 3。
- **版本指纹**：启动 `run` 时对题目文件、mock 源码、surface 文本 + 运行时源码计算内容 hash，记录在 `runs/fingerprints.json`；
  内容变了而版本号没变 → 拒绝运行，提示要 bump 哪个版本。判分代码不在指纹里（改判分用 `regrade`）。
- `runs/` 整个目录被 `.gitignore` 忽略。

## 目录

```
bench/
├── manifest.yaml            实验矩阵、harness_version、参数（temperature 0.6, max_tokens 16000, 最多 4 轮）、预算
├── tasks/
│   ├── C1 … C8/*.yaml       题目（语言无关；参考答案由脚本计算后固化在文件里）
│   ├── mock/world.js        确定性 mock 世界 core-v1：生成器、tool、JSON Schema、ToolHost（故障注入 + effect 记录）
│   ├── mock/index.js        世界注册 + 数据补丁
│   └── reference.js         参考解（只给 check-tasks 用，判分不读它）
├── harness/
│   ├── cli.js               plan / run / status / regrade / selfcheck / check-tasks / ping
│   ├── cells.js             题目加载、格子展开、结果存储、版本指纹
│   ├── episode.js           单个 episode 的交互循环
│   ├── surface/rules.js     JS / Lua 逐条对齐的规则表 + 错误提示表
│   ├── surface/surface.js   tool 签名、run 工具说明、formatResult
│   ├── runtimes/js.js       node:vm 运行时（类 eta ESM）
│   ├── runtimes/lua-interim.js + lua/prelude.lua   wasmoon 运行时
│   ├── llm/                 client（缓存、账本、预算）、pricing、secrets
│   ├── grade/               答案比较、状态 diff、effects 检查、错误标签、扇出分类
│   ├── models.yaml, pricing.yaml
├── analysis/smoke.js        从结果文件生成报告用的表格
├── reports/                 提交的报告（smoke-1.md）
├── test/                    运行时测试 + 用脚本化假模型跑的端到端判分测试
└── runs/                    （gitignore）results/、cache/llm/、ledger.jsonl、fingerprints.json
```

## lua-interim 与 luajs surface 的差异

见 `reports/smoke-1.md` §8"临时 Lua 运行时（lua-interim）和 ARCHITECTURE 的差距"。要点：数据边界用纯 Lua 的 JSON 编解码 + 形状元表近似 ARCHITECTURE §8；
tool 入参的空表按 schema 修正；数组末尾的 null 不保留；`pairs` 顺序确定但不是插入序；没有 `parallel`（smoke 决定不提供）。

## 加一道题

1. 在 `tasks/C<n>/` 新建 yaml（格式见 BENCH.md §1.3；`expect.answer.value` 可先写 `FILLED_BY_SCRIPT`）。
2. 在 `tasks/reference.js` 写参考解（以及需要时的前置条件检查）。
3. `node harness/cli.js check-tasks --write`，人工复核写进去的值。
4. 改题目时 `version + 1`；改 `world.js` 时 `MOCK_VERSION + 1` 并同步所有题目的 `mock_version`。
