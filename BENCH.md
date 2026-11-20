# luajs codemode 评测方案

本文是 luajs 自建 codemode 评测集与评测框架的**设计文档**，不含实现代码。运行时本身的架构见 [ARCHITECTURE.md](ARCHITECTURE.md)；文中出现的 `§x.y`（不带文件名时）指本文章节，`ARCHITECTURE §x.y` 指架构文档章节。

---

## 目录

0. [目的、范围与为什么自建](#0-目的范围与为什么自建)
1. [任务集设计](#1-任务集设计)
2. [实验条件](#2-实验条件)
3. [指标与产出](#3-指标与产出)
4. [可断点恢复、不重复花钱](#4-可断点恢复不重复花钱)
5. [费用预估](#5-费用预估)
6. [目录规划](#6-目录规划)
7. [待决问题](#7-待决问题)

---

## 0. 目的、范围与为什么自建

### 0.1 目的

1. **决定原语**：用统计数据决定 runtime 给模型提供哪些原语（`parallel`、`state`、`array()` 等，见 ARCHITECTURE §7.1），哪些做成 tool，哪些不提供。
2. **Lua vs JS**：在同一套任务、同一套 tool、同一种说明风格下，对比模型写 Lua 和写 JS 的表现。

### 0.2 范围

只评测**低端任务**：调用一两个 tool（或一次列表 + 扇出），再整理一下数据。这与 ARCHITECTURE §1.3 "VM 里只做两件事：调用 tool、整理数据" 一致。复杂编排（多步规划、长链路）归 eta 的 ESM 模式，不在本评测范围内。

### 0.3 为什么自建

- Hugging Face 上已有的 codemode 轨迹（Exgentic/agent-llm-traces-v2、snorkelai 的 τ² code-agent 数据集、smolagents/codeagent-traces 等）用的都是旧模型。
- 我们关心的新模型（qwen3.8、glm-5.3、deepseek-v4.1-flash）公开数据只有 SWE 轨迹或合成的 JSON function-calling 数据，不能回答"写 Lua codemode 怎么样"。
- 因此：**任务集自己设计，模型输出自己跑**。τ²-bench、AppWorld、BFCL（simple / multiple / parallel 类）只作为出题的参考来源，每道题记录它参考了哪里（`source` 字段），但题面、数据、判分都是我们自己的。

### 0.4 评测模型

只用三个模型，不跑旧模型：

| 模型 | provider 中的 id |
| --- | --- |
| qwen3.8 | `qwen3.8-max` |
| glm-5.3 | `glm-5.3` |
| deepseek-v4.1-flash | `deepseek-v4.1-flash` |

---

## 1. 任务集设计

### 1.1 类别（共约 120 题，每类约 15 题）

| # | 类别 | 典型形态 | 主要考察 / 对应的原语或决定 |
| --- | --- | --- | --- |
| C1 | 单次查询 + 字段提取 | 1 次 tool 调用，取出几个字段 | 基本语法、最后表达式即结果（ARCHITECTURE §10.2 规则 1） |
| C2 | 查询 + 过滤、排序、分组聚合 | 1–2 次调用，`filter / sort / group by / sum` | `table.sort`、手写分组；是否需要提供集合类 helper |
| C3 | 扇出 | 先列出列表，再逐项查详情（N 次调用） | `parallel{...}` 的使用率与正确性；串行 vs 并发 |
| C4 | 条件写入 | 先检查再修改，有副作用 | 检查顺序、不多写不错写；用 mock 状态 diff 判分 |
| C5 | 文本处理 | 截断、格式化、拼接、含中文的 UTF-8 | 专门暴露 `#s` 是字节数、`string.sub` 按字节切的坑（ARCHITECTURE §10.2 规则 5） |
| C6 | 数据边界 | `null`、字段缺失、空数组、数字 ID 当 key | 对应 ARCHITECTURE §8（null→nil、`ipairs` 遇空洞停、数字 key 保持字符串、空表 `{}` vs `array()`） |
| C7 | 错误处理 | tool 失败或被 Authorizer 拒绝 | 结构化错误表 + `pcall`（ARCHITECTURE §9.3）；失败后是否继续、是否正确报告 |
| C8 | 反例 | 只需一次调用，本来用不着 codemode | 衡量 codemode 的固定开销（token、轮数、出错率） |

每类内部按难度分布：约 5 题"一眼就会"、约 7 题"有一个坑"、约 3 题"有两个坑或需要组合"。

C5、C6 的题必须让坑**真的影响答案**（例如截断后的中文标题会被判错、字段缺失会让聚合结果变化），而不是只要跑通就算对。

### 1.2 mock 世界

所有 tool 都是**确定性的、进程内实现的 mock**：不联网、不花钱、可复现。

- **数据生成**：一个种子 → 一个虚构世界。实体包括用户、组织、订单、商品、issue、评论、文件（含中文文件名与内容）等。生成器使用固定的 PRNG（如 xorshift / mulberry32），不使用 `Math.random`、当前时间、`Date.now()`。时间字段从固定的基准时间按种子偏移。
- **scope 划分**（示意，最终以 `bench/tasks/mock/` 为准）：

  | scope | 例子 |
  | --- | --- |
  | `crm` | `list_users`、`get_user`、`update_user` |
  | `shop` | `list_orders`、`get_order`、`refund_order`、`list_products` |
  | `tracker` | `list_issues`、`get_issue`、`add_label`、`close_issue`、`add_comment` |
  | `files` | `list_dir`、`read_file`、`write_file` |

- **JSON Schema**：每个 tool 都有 input schema 和 output schema，与 ARCHITECTURE §6 的 `ToolDescriptor` 同形，可以直接喂给 L3 的签名生成（ARCHITECTURE §10.3）。JS 组用同一份 schema 生成 TS 风格签名。
- **状态**：mock 世界是一个可序列化的 JSON 状态。写 tool 修改状态；每个 episode 从同一个初始状态开始（深拷贝），互不影响。
- **故障注入**（C7 用）：题目可以声明 `faults`，例如"`shop.get_order` 对 id=1042 返回 `tool_failed`"、"`tracker.close_issue` 被 Authorizer 拒绝"。故障也是确定性的，按参数匹配，不按调用次序随机。
- **数据边界注入**（C6 用）：题目可以对生成的数据打补丁（某字段置 `null`、删除字段、空数组、用数字字符串作对象 key）。
- **输出稳定**：tool 返回值的对象 key 排序，列表顺序由生成器决定，不依赖 Map 插入顺序以外的东西。

### 1.3 题目文件格式

每题一个文件（`bench/tasks/<category>/<id>.yaml`），语言无关——同一道题既给 JS 组也给 Lua 组。

```yaml
id: c3-order-details-07
version: 2                     # 题目任何改动都要 +1，见 §4.6
category: C3
source: "BFCL parallel_multiple 风格改写"   # 参考来源，可为空
mock:
  world: shop-v1               # mock 世界名
  mock_version: 3              # 依赖的 mock 实现版本
  seed: 4217
  patches: []                  # C6 的数据补丁
  faults: []                   # C7 的故障注入
scopes: [shop]                 # 本题暴露哪些 scope
instruction: |
  列出用户 u_17 所有状态为 shipped 的订单，返回每个订单的 id 和商品名列表，按 id 升序。
expect:
  answer:
    compare: json_equal        # json_equal | set_equal | numeric_tol | text_normalized | custom
    value: [...]               # 由 mock 计算出的参考答案，生成后固化在文件里
  state_diff:                  # 期望的 mock 状态变化；只读题为空
    set: {}
    delete: []
  effects:                     # 调用记录约束
    must_call: [shop.list_orders]
    must_not_call: [shop.refund_order]
    max_calls: 30
    order: []                  # 例：["tracker.get_issue < tracker.close_issue"]
```

参考答案由脚本对 mock 世界直接计算，然后**固化进题目文件**并人工复核；判分时不重新计算，避免判分代码的 bug 与题目一起漂移。

### 1.4 判分

一个 episode 判为通过，当且仅当三项都通过：

1. **最终答案检查**：取模型最后一次成功 run 的返回值（结构化 JSON），按 `expect.answer.compare` 比较。C8 和部分 C4 题只要求"答案非错"，可设为 `compare: any`。
2. **mock 状态 diff**：episode 结束时对 mock 状态做 diff（按 JSON 路径），必须与 `expect.state_diff` 完全一致——多写、少写、写错都算失败。
3. **effects 检查**：根据调用记录（tool、参数、状态 ok/failed/denied、调用所在行）检查 `must_call`、`must_not_call`、`max_calls`、`order`。

注意：失败 run 的副作用不回滚（ARCHITECTURE §5.5、§10.2 规则 10），所以 state diff 和 effects 要累积**整个 episode**（所有轮次），而不是只看最后一次 run。

### 1.5 版本

- 每题有 `version`；每个 mock 世界实现有 `mock_version`。
- 两者共同组成 §4 中的 `task_version`：`task_version = "<version>+m<mock_version>"`。改了 mock 实现，只有依赖它的题失效。

---

## 2. 实验条件

### 2.1 语言组

| 组 | 运行时 | tool 形态 | 并发 |
| --- | --- | --- | --- |
| JS | 类似 eta ESM 的运行时：隔离执行（`node:vm` 或 QuickJS-wasm），最后一个表达式为结果 | `await shop.get_order({id})`，失败抛错 | `Promise.all` |
| Lua | luajs（`createRealm` + 默认 wasm Engine） | `shop.get_order{id = ...}`，看起来同步，失败抛结构化错误表 | `parallel{...}` |

两组接同一个 mock ToolHost、同一个 Authorizer（故障注入在这里实现）、同一个 effect 记录器，判分完全共享。

luajs 就绪之前 Lua 组怎么办，见 [§7.1](#71-luajs-就绪之前lua-组怎么跑)。

### 2.2 交互方式

- 给模型的**只有一个工具 `run`**（codemode），参数是一段代码；不提供其他 tool。
- **单条用户指令**，不使用用户模拟器（省 token；τ² 那种多轮对话不在范围内）。
- **每题最多 4 轮**：一轮 = 一次模型回复。模型回复里调用了 `run` → 执行并把 `formatResult` 的文本作为 tool result 返回；模型回复里没有 `run` 调用 → episode 结束。第 4 轮的 `run` 仍会执行并参与判分，但不再请求模型。
- **temperature 固定**（建议 0.6；三个模型统一取同一个值，写在 harness 配置里，属于 `harness_version` 的一部分）。思考模式按各模型默认开启，`max_tokens` 统一。
- **每个格子重复 3 次**（`repeat = 0,1,2`），用于 pass^3。

### 2.3 统一的 surface 与结果格式

- 两种语言用**同一套结构**的说明文本：静态规则 + tool 签名 + 指令。
  - Lua：规则取 ARCHITECTURE §10.2，签名取 L3 `describeSurface` 的输出。
  - JS：同样数量、同样语气的规则（例如"最后一个表达式是结果"、"tool 是 async 函数，失败时抛错"、"用 `Promise.all` 并发"），签名用同一份 schema 生成的 TS 风格。
  - 两种语言的规则逐条对齐，放在一个表里维护（`bench/harness/surface/`），差异只在语言本身必须不同的地方。
- 结果格式统一按 ARCHITECTURE §9.6 `formatResult`：值或错误（含出错行与提示）→ warnings → logs 尾部 → effects → committed state。JS 组实现一个同格式的 formatter。
- **结果文本中不得包含任何非确定性内容**（耗时、内存峰值、时间戳、随机 id），否则会破坏 §4.4 的缓存重放。`stats` 只进结果记录，不进给模型的文本。

### 2.4 可选组：JSON tool-calling 基线

- 把 mock tool 直接以普通 function calling 暴露给模型（不提供 `run`），模型自己多轮调用、最后以 JSON 给出答案。
- 用来比较 codemode 和普通调用（尤其是 C3 扇出和 C8 反例的 token / 轮数）。
- 轮数上限放宽到 8（普通调用做扇出天然需要更多轮；允许一轮内并行多个 function call）。
- **默认关闭**，在 manifest 里显式打开（`lang: json`），以节省 token。

---

## 3. 指标与产出

### 3.1 结果指标

| 指标 | 定义 |
| --- | --- |
| pass@1 | 所有 (题, 重复) 的通过率均值，按模型 × 语言 × 类别报告 |
| pass^3 | 3 次重复**全部**通过的题占比（衡量稳定性） |
| 成功所需轮数 | 通过的 episode 用了几轮；同时报告"第 1 轮就通过"的比例 |
| token 与费用 | 每 episode、每次成功的输入 / 输出 / 思考 / 缓存命中 token 与费用 |
| 预算超限率 | run 状态为 `budget` 的比例 |

置信区间：按题做 bootstrap（重采样题目，1000 次）。Lua vs JS 用**同题配对**比较（配对 bootstrap 或 McNemar），不做非配对比较。样本量有限，类别级结论只看大差距，不解读个位数百分点。

### 3.2 错误分类

每个失败的 run（不只是失败的 episode）都打一个主标签，由规则自动分类，规则分不出来的进 `unknown` 人工过一遍：

| 标签 | 判定依据（示例） |
| --- | --- |
| `syntax` | run status = `syntax` |
| `js_ism` | Lua 组里出现 `!=`、`+` 拼字符串、`.length`、`===`、`//` 注释等（命中 ARCHITECTURE §9.5 提示表） |
| `unknown_api` | 调用了不存在的 tool / 全局 / 标准库函数（`table.filter`、`string.split`、`JSON.parse` 等） |
| `nil_null` | 对 nil 索引、`ipairs` 提前停止导致答案缺项、`undefined`/`null` 访问 |
| `type` | 字符串与数字比较、数字 key 与字符串 key 混用、拼接 nil |
| `utf8` | 按字节截断导致非法 UTF-8 / U+FFFD 出现在答案里 |
| `tool_error_unhandled` | tool 失败或被拒后整个 run 崩掉，而题目要求继续 |
| `wrong_side_effect` | 状态 diff 或 effects 检查失败（多写 / 写错 / 顺序错） |
| `budget` | 预算超限 |
| `wrong_answer` | 跑通了但答案不对 |
| `no_answer` | 4 轮用完或模型放弃 |

### 3.3 重跑链

对每个"出错 → 下一轮重写"的序列记录：

- 前后两版代码的 diff（行级）以及错误标签；
- 修复类型：只改报错行 / 改写一段 / 整体重写 / 换了做法（例如串行改 `parallel`）；
- 是否被提示表的 hint 引导（下一版代码是否正好做了 hint 建议的改动）。

产出用于：评估错误提示表（ARCHITECTURE §9.5）每条 hint 的命中率与修复率；发现应该补进提示表或 surface 规则的条目。

### 3.4 原语使用统计（AST）

对每份提交的代码做 AST 统计（Lua 用 luaparse 或 luajs 自身的解析结果，JS 用 acorn），按语言分别实现同一组检测器：

| 检测项 | Lua 中的形态 | JS 中的形态 |
| --- | --- | --- |
| 扇出 | 循环体内调用 tool | 循环 / `map` 内 `await` tool |
| 并发 | `parallel{...}` | `Promise.all` / `allSettled` |
| 排序 | `table.sort` | `.sort` |
| 分组 / 计数 | 以字段为 key 累加的 table | `reduce` / 对象累加 / `Map` |
| 过滤 / 映射 | 手写循环 + 条件 | `filter` / `map` |
| 字符串截断 | `string.sub`、`utf8.offset`、`utf8.len` | `slice` / `substring`、`Array.from` |
| 字符串格式化 | `string.format`、`..` 拼接 | 模板字符串 |
| 异常处理 | `pcall` / `error` | `try/catch` |
| 跨 run 状态 | `state.x` | 对应机制 |
| 空数组构造 | `array()` | `[]` |
| 手写 helper | 自定义 `split`、`map`、`keys`、`join` 等函数 | 同左 |

还要统计 C3 中**应该并发却串行**的比例、每题的 tool 调用次数分布。

### 3.5 最终产出：原语候选清单

`analysis/` 输出一份报告，每个候选原语一行，附数据依据：

| 候选 | 建议 | 依据（示例格式） |
| --- | --- | --- |
| `parallel` | 保留 / 改语义 / 去掉 | C3 中 Lua 组使用率 x%，使用时通过率 y% vs 串行 z%，相关错误 n 次 |
| `string.split` 类 helper | 提供 / 不提供 | x% 的 C5 代码手写了 split，其中 y% 写错 |
| `array()` | … | … |
| 集合 helper（map/filter/group） | 提供为原语 / 做成 tool / 不提供 | … |

判定原则（初稿，分析阶段可调）：

- **手写率高且手写出错率高** → 提供为原语；
- **手写率高但很少出错** → 不提供，写进 surface 例子即可；
- **很少用到** → 不提供；
- **需要 host 资源或很慢也无所谓** → 做成 tool（符合 ARCHITECTURE §1.3）；
- 同一项在 JS 组几乎不出错、在 Lua 组频繁出错 → 优先考虑补 surface 规则或提示表，再考虑加原语。

---

## 4. 可断点恢复、不重复花钱

**硬性要求**：任何时候中断（Ctrl-C、断网、进程崩溃、预算到顶），重新启动都只做没做完的部分；已经花过钱的模型请求永远不再付第二次钱。下面写到可以照着实现的程度。

### 4.1 manifest 与格子

实验矩阵由 `bench/manifest.yaml` 定义：

```yaml
harness_version:              # 按语言拆开，改一种语言的适配器不影响另一种
  common: 3                   # surface 公共部分、判分、temperature 等参数
  js: 2
  lua: 1
  json: 1
models: [qwen3.8-max, glm-5.3, deepseek-v4.1-flash]
stages:
  smoke: { tasks: "pick:5", langs: [lua], repeats: 1 }          # 每个模型 5 题
  pilot: { tasks: "per_category:2", langs: [js, lua], repeats: 1 }
  full:  { tasks: all, langs: [js, lua], repeats: 3 }
  # baseline: { tasks: all, langs: [json], repeats: 3 }       # 默认不启用
budget_usd: { smoke: 2, pilot: 10, full: 80 }
```

展开规则：stage × model × lang × task × repeat → 一个**格子（cell）**。

格子 key：

```
cell_key = sha256(canonical_json({
  task_id, task_version, model, lang,
  harness_version: "<common>.<lang>",   # 例如 "3.1"
  repeat
}))
```

- `canonical_json`：key 排序、无空白、UTF-8。所有 hash 都用同一个函数。
- `stage` **不进 key**：smoke 和 pilot 跑过的格子，如果 full 里有完全相同的格子（同题、同版本、同 repeat），直接复用，不重跑。
- `task_version` 见 §1.5。

### 4.2 结果存储：append-only JSONL

- 文件：`bench/runs/results/<model>.<lang>.jsonl`（按模型和语言分文件，避免多个写者竞争同一文件）。
- 每行一个**完整的**格子结果：

  ```json
  {"cell_key":"…","task_id":"…","task_version":"2+m3","model":"…","lang":"lua",
   "harness_version":"3.1","repeat":0,"status":"done",
   "pass":true,"checks":{"answer":true,"state_diff":true,"effects":true},
   "turns":[{"code":"…","run_status":"ok","error_tag":null,"llm_key":"…"}],
   "usage":{"input":11234,"cached_input":8000,"output":2100,"reasoning":1500},
   "cost_usd":0.0123,"finished_at":"…"}
  ```

- **一个格子跑完才写**：episode 进行中的状态只在内存里；全部轮次跑完、判分完成后，把整行序列化成一个 buffer，用 `O_APPEND` 一次 `write` 写入并 `fsync`。不写"开始"记录，不写半个格子。
- 读取时容忍**最后一行不完整**（崩溃在 write 中途）：解析失败的末行丢弃并告警，该格子视为未完成。
- **基础设施失败不算完成**：provider 报错重试耗尽、网络断开、harness 自身异常时，不写结果行（或写 `status: "infra_error"`，扫描时不计入已完成），下次启动会重跑——由于 §4.3 的缓存，重跑不会重复花钱。
- 同一个 key 出现多行（极少见，例如人工合并文件）时取最后一行。

### 4.3 启动扫描与跳过

`bench run --stage <s>` 启动流程：

1. 读取 manifest 与所有题目，展开该 stage 的全部格子，计算 key。
2. 扫描 `runs/results/*.jsonl`，收集 `status = "done"` 的 key 集合。
3. 待跑 = 展开集合 − 已完成集合。打印 "共 N 格，已完成 M，待跑 K"。
4. 对待跑格子按 (model, lang) 分组，在每个 provider 的并发上限内执行。
5. 每完成一个格子立即按 §4.2 落盘。

### 4.4 LLM 请求级缓存

```
llm_key = sha256(canonical_json({
  model,
  messages,          # 完整的消息列表（含 system、tool 定义、历史 tool result）
  params,            # temperature、max_tokens、思考开关等，发给 API 的全部参数
  sample: repeat     # 不发给 API，只进 key
}))
```

- **`sample` 必须进 key**：否则同一题的 3 次重复会命中同一条缓存，返回同一个回复，pass^3 退化为 pass@1。
- 不进 key 的：API key、baseUrl、请求头、请求时间。（换 provider 镜像不应导致重跑；如需区分，显式改 `model`。）
- 存储：`bench/runs/cache/llm/<前2位>/<llm_key>.json`，内容是完整请求体（不含密钥和头）、**完整响应**（含思考内容、tool call、`usage`、finish_reason）、计算出的费用、时间戳。先写临时文件再 `rename`，保证原子。
- 只缓存**完整、成功**的响应（HTTP 2xx 且 finish_reason 正常或为 length）。流式响应在内存中拼完整后再写。错误响应不缓存。
- 每次真实请求同时追加一行到 `runs/ledger.jsonl`（`llm_key`、model、usage、cost、时间）作为花费账本。

**为什么能从断点继续**：mock tool 是确定性的（§1.2），运行时输出不含非确定性内容（§2.3），所以重新执行一个中断的格子时，第 1 轮请求的 messages 与上次完全相同 → 命中缓存 → 得到同一段代码 → 执行得到同一个 tool result → 第 2 轮 messages 也相同 → 继续命中……直到上次中断的位置才发出真实请求。已花过的 token 不再花。

配套要求：

- harness 有一个**确定性自检**：同一格子用缓存连续重放两次，所有 messages 的 hash 必须一致；CI 里对 smoke 的缓存跑这个检查。
- 重放过程中如果某一轮未命中缓存，但该格子在 ledger 中已有更后面轮次的记录，说明出现了非确定性：记告警并在结果行标 `nondeterministic: true`。
- `bench run --offline`：缓存未命中直接报错、不发请求。**重新判分、重新做分析一律用 offline 模式**，只读缓存和结果，不调用模型。
- `bench regrade`：改了判分逻辑（不改题目答案）时，用缓存重放所有格子并重新判分，产出新结果文件；这不花钱。（判分逻辑属于 `harness_version.common`，若改动不影响 messages，可走 regrade 而不必失效格子，见 §4.6。）

### 4.5 预算护栏

- **价格表**：`bench/harness/pricing.yaml`，每个模型的输入 / 缓存命中输入 / 输出单价，带 `as_of` 日期。思考 token 按输出计价（除非 provider 另有规定）。
- **实时累计**：每次真实请求返回后，用 `usage` × 单价计算费用，累加到本次进程的计数，并写入 ledger。缓存命中的请求费用记 0。
- **发请求前检查**：`已花费（ledger 中本 stage 的合计） + 本请求的最坏费用（输入估算 + max_tokens × 输出单价） > budget_usd[stage]` 时，不再发新请求：
  - 不再开始新格子；
  - 正在进行中的格子就地放弃（不写结果行；它已发出的请求都已缓存，下次继续）；
  - 打印已花费、剩余格子数，退出码非 0。
- 也支持命令行覆盖：`--budget 5`（只能调低，不能超过 manifest 中的值，除非同时改 manifest）。
- **dry-run**：`bench plan --stage <s>`（等价 `bench run --dry-run`）不发任何请求，打印：
  - 每个 (model, lang) 待跑格子数；
  - 预估费用：有 pilot 实测数据时用实测的每 episode 平均 token，否则用 §5 的假设（12k 输入 / 3k 输出）；
  - ledger 中该 stage 已花费、预算余量；
  - 预估是否会超预算。

### 4.6 分阶段执行

| 阶段 | 内容 | 目的 |
| --- | --- | --- |
| smoke | 每个模型 5 题 × 1 种语言 × 1 次 | 打通 provider、缓存、判分；发现 surface 的明显问题 |
| pilot | 每类 2 题（16 题）× 两种语言 × 1 次 | 校准费用估算、检查题目是否太难 / 太易、判分是否误判 |
| full | 全部题 × 两种语言 × 3 次 | 正式数据 |

- 每个阶段都要**显式启动**：`bench run --stage smoke`。没有"一键全跑"，跑完一个阶段不会自动进入下一个。
- `full` 启动前检查 pilot 是否已完成且没有 `infra_error`、没有 `nondeterministic`，否则拒绝启动（可用 `--force` 越过）。
- 每个阶段结束打印小结：通过率、实际费用 vs 预估、错误标签分布。

### 4.7 局部失效

key 中带版本，所以失效是**自动且局部**的：

| 改动 | 需要做的 | 失效范围 |
| --- | --- | --- |
| 改一道题（题面、数据补丁、期望） | 该题 `version + 1` | 只有这道题的格子 |
| 改某个 mock 世界的实现 | 该世界 `mock_version + 1` | 依赖它的题 |
| 改 Lua 适配器 / luajs 版本 / Lua 专属规则 | `harness_version.lua + 1` | 所有 Lua 格子 |
| 改 JS 适配器 | `harness_version.js + 1` | 所有 JS 格子 |
| 改公共 surface、temperature 等发给模型的东西 | `harness_version.common + 1` | 全部格子 |
| 只改判分逻辑或分析代码 | 不改版本，执行 `bench regrade` | 不重跑模型 |

- 旧版本的结果行保留在 JSONL 中但不被当前 manifest 匹配；分析只读当前 manifest 展开出的 key。
- `bench status` 列出每个 stage 的完成度，以及"结果文件中存在但当前 manifest 已不匹配"的过期行数；`bench gc` 可选择把过期行归档到 `runs/archive/`，不删除。
- 版本号由人维护，但 harness 启动时会对题目文件、mock 源码、surface 文本计算内容 hash，与上次运行时记录的 hash 比较：**内容变了而版本号没变 → 拒绝运行**并提示要 bump 哪个版本，防止忘改版本导致新旧结果混在一起。

### 4.8 密钥与仓库卫生

- provider 的 baseUrl 和 API key 只从环境变量读取，命名为 `BENCH_<PROVIDER>_BASE_URL`、`BENCH_<PROVIDER>_API_KEY`；model → provider 的映射写在 `bench/harness/models.yaml`（只含 id 和 env 前缀，不含值）。
- 缓存文件、ledger、日志中**不记录**请求头、API key、baseUrl。
- `bench/runs/` 整个目录（结果、缓存、ledger、日志）默认 gitignore。需要公开的汇总报告由 `analysis/` 生成后单独提交。

---

## 5. 费用预估

> **以下是估算**，价格来自第三方汇总，以各 provider 官方价格为准；开跑前用 `bench plan` 按当时的价格表重新计算。

假设：

- 120 题 × 2 种语言 × 3 次重复 = **每个模型 720 次 episode**，再加约 10% 的试跑（smoke + pilot + 重跑）≈ 790 次。
- 每次 episode 输入约 12k token（说明 + 签名 + 最多几轮上下文累计），输出约 3k token（含思考）。
- 每个模型合计约 **9.5M 输入、2.4M 输出**。

| 模型 | 输入单价 | 输出单价 | 估算 |
| --- | --- | --- | --- |
| deepseek-v4.1-flash | ~$0.30 / M | ~$1.20 / M | ~$6（低峰时段价格减半） |
| glm-5.3 | ~$1.40 / M | ~$4.40 / M | ~$24 |
| qwen3.8-max | ~$2 / M | ~$6 / M（输出含思考 token） | ~$33 |
| **合计** | | | **~$60–70** |

修正因素：

- **prompt 缓存**：system + 规则 + 签名是稳定前缀，多轮之间历史也是前缀，命中后输入成本明显下降，实际花费可能在上表的**一半左右**。
- **JSON 基线组**：如果开启，每个模型约多 **1/3**。
- **订阅制 provider**：如果用户使用的是订阅制 provider，实际按订阅额度计算，上表只作为用量参考。
- 断点恢复和请求缓存保证中断、重新分析、重新判分都不额外花钱；真正可能多花的只有因改版本而失效的格子。

建议预算设置（写入 manifest）：smoke $2、pilot $10、full $80。

---

## 6. 目录规划

只是规划，本次不建代码。

```
bench/
├── manifest.yaml            # 实验矩阵、阶段、预算（§4.1）
├── tasks/                   # 题目与 mock，进仓库
│   ├── C1/ … C8/            # 每题一个 yaml（§1.3）
│   └── mock/                # 确定性 mock 世界：生成器、tool 实现、JSON Schema、故障注入
├── harness/                 # 评测框架，进仓库
│   ├── surface/             # JS / Lua 对齐的规则文本与签名生成
│   ├── runtimes/            # js（ESM 风格）、lua（luajs；或临时参考运行时）、json 基线
│   ├── llm/                 # provider 客户端、请求缓存、ledger、预算护栏
│   ├── grade/               # 答案比较、state diff、effects 检查
│   ├── models.yaml          # 模型 id → 环境变量前缀
│   ├── pricing.yaml         # 单价与 as_of
│   └── cli                  # plan / run / status / regrade / gc
├── runs/                    # 全部 gitignore
│   ├── results/             # <model>.<lang>.jsonl
│   ├── cache/llm/           # 请求级缓存
│   ├── ledger.jsonl         # 花费账本
│   └── archive/             # gc 归档的过期结果
└── analysis/                # 指标、错误分类、AST 统计、原语候选报告，进仓库
```

`.gitignore` 中加入 `bench/runs/`。

---

## 7. 待决问题

### 7.1 luajs 就绪之前，Lua 组怎么跑

**做法 A：等待 luajs。** JS 组、mock、判分、缓存先做完，先跑 JS 组；Lua 组等 luajs 的 L2/L3 可用后再跑。

- 优点：Lua 组的数据直接反映 luajs 真实的 surface、错误格式、提示表、数据边界行为；不会有"参考运行时与 luajs 不一致"导致的数据作废；不多花钱。
- 缺点：Lua vs JS 的对比、以及原语决策要等 luajs 做完才有数据——但评测本来就是为了指导 luajs 的设计（原语、提示表、数据边界），等它做完再测，结论来得太晚，改动成本更高。

**做法 B：先用临时参考运行时（如 wasmoon，Lua 5.4 wasm），按同一套 surface 规则跑。** 在 wasmoon 上用 JS 包一层，尽量模拟 luajs 的 surface：strict globals、tool 同步调用（借 wasmoon 的 async/协程支持）、`parallel`、结构化错误表、`array()`、null→nil、`formatResult` 同格式输出。

- 优点：能尽早拿到 Lua 组数据，用来指导 luajs 的设计（这正是目的 (a)）；harness 的 Lua 适配层接口与 luajs 一致，以后换成 luajs 只改适配器。
- 缺点：
  - 数据边界（形状标记、`__len`、空表编码，ARCHITECTURE §8）、错误 traceback 和提示的细节很难完全模拟，C6、C7 的数据可信度较低；
  - 换成 luajs 时 `harness_version.lua` 必须 bump，Lua 格子全部失效、要重新花钱（按 §5 约为 Lua 组那一半的费用）；
  - 要额外维护一个临时适配器。

**倾向（待用户决定）**：做法 B，但**只跑 smoke + pilot**（花费在 $10 量级），用来尽早修正 surface 和原语方向；Lua 组的 full 等 luajs 就绪后再跑。参考运行时的结果在报告中单独标注，不与 luajs 的结果混用。

### 7.2 其他

- **指令语言**：题面用中文还是英文。倾向：题面中文为主（与目标使用场景一致），C5 必须有中文数据；可在 pilot 里各放一半观察差异。
- **temperature 取值**：0 会让 3 次重复几乎相同，pass^3 失去意义；倾向统一取 0.6，pilot 后再定。
- **原语消融**：要回答"提供 X 原语到底有没有用"，最终可能需要 surface 变体（有 / 无 `parallel` 等）做消融。变体作为 `harness_version.lua` 的一个维度引入，默认不做，等 full 的观察数据出来再决定是否值得花这笔钱。
- **`parallel` 的失败语义**（ARCHITECTURE §11）：C3 + C7 的组合题会给出模型在分支失败时的预期行为，可作为该问题的参考数据。
