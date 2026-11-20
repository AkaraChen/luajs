# luajs 架构

luajs 是一个面向 coding agent codemode 的 Lua 运行时，宿主为 JS（Node / Bun）。默认引擎把 Lua 5.4/5.5 编译成 wasm，再加一层 C glue；暂不考虑 napi。

本文只描述架构决定，不含实现代码。后续讨论和实现以本文为准。

原语取舍、surface 规则与错误提示表的有效性，由自建评测集验证，方案见 [BENCH.md](BENCH.md)。

---

## 目录

1. [定位与依据](#1-定位与依据)
2. [总原则](#2-总原则)
3. [分层与目录](#3-分层与目录)
4. [L0 / L1：步进状态机与 Engine 契约](#4-l0--l1步进状态机与-engine-契约)
5. [L2：Realm](#5-l2realm)
6. [Ports（由调用方实现）](#6-ports由调用方实现)
7. [VM 内能力范围](#7-vm-内能力范围)
8. [数据边界（Lua ↔ JSON）](#8-数据边界lua--json)
9. [错误模型](#9-错误模型)
10. [L3：surface（给 LLM 看）](#10-l3surface给-llm-看)
11. [待讨论](#11-待讨论)

---

## 1. 定位与依据

### 1.1 codemode 的成本在哪里

依据：[rivet-dev/code-mode-language-benchmark](https://github.com/rivet-dev/code-mode-language-benchmark)。

- codemode 脚本很短（约 5–60 行），大部分时间花在等 tool 返回。
- 真正的成本是：**实例内存、首次响应时间、tool 调用往返、数据编解码、挂起调用的开销**。解释器本身算得快不快是次要的。
- 参考数据：

  | 指标 | Lua | Node 中的 wasm 版 QuickJS |
  | --- | --- | --- |
  | state 内存 | ~16 KB | — |
  | 启动 | ~13 µs | — |
  | 一次 tool 调用 | ~0.4 µs | ~26.7 µs |

  QuickJS 的数字说明：**跨 wasm/JS 边界本身就很贵**。因此 luajs 的设计重点是减少边界穿越次数、减少每次穿越携带的开销。

### 1.2 与 eta ESM 模式对齐

依据：[eta](https://github.com/0xfe-project/eta) 的 ESM 模式（`packages/eta-harness/src/esm.ts` 与 `realm/`）。

luajs 将来会与 eta 的 ESM 模式并存，所以接口尽量对齐 eta 的形状：**Realm / Effect / Authorizer / 能力分层**。具体策略与存储由调用方（eta）实现。

### 1.3 能力边界

- **VM 里只做两件事：调用 tool、整理数据。** 这两件事要快。
- 其他一切都交给 host，以 tool 的形式提供，慢一点没关系。

---

## 2. 总原则

### 2.1 堆只是缓存

- 真实数据在调用方的存储里（StateStore、CapabilityStore）。
- luajs 自己不持久化任何东西，不碰磁盘。
- kill、重建、wasm trap 之后都只需要重新 wake。

### 2.2 不因"表示方式"让一次 run 失败

- 能降级就降级，降级到**保留信息最多**的形式，并附 warning。
- **只有错误的数据会进入 tool 入参时才报错**，因为那可能触发错误的副作用。
- 理由：luajs 一次报错会导致模型重跑一轮，耗时是秒级，会抵消掉所有微秒级优化。

---

## 3. 分层与目录

```
┌──────────────────────────────────────────────────────────┐
│ L3 surface   纯函数：签名 / 能力 delta / tool spec /        │
│              formatResult / 错误提示表                     │
├──────────────────────────────────────────────────────────┤
│ L2 Realm     会话语义：wake / run / keep / kill、scope 组装、│
│              snippet 改写、strict globals、state diff、     │
│              effect ledger、并发 run                       │
├──────────────────────────────────────────────────────────┤
│ L1 Engine    加载 wasm、管理多个 lua_State、编解码、         │
│              驱动 step 循环、资源预算（只有机制，没有策略）    │
├──────────────────────────────────────────────────────────┤
│ L0 core.wasm C：Lua + glue。同步步进状态机，不知道 Promise   │
└──────────────────────────────────────────────────────────┘
          ports.ts：全部接口集中于此，零依赖
```

| 层 | 目录 | 职责 |
| --- | --- | --- |
| L0 | `core/` | Lua 源码 + C glue，编译为 `core.wasm`。同步的步进状态机。 |
| L1 | `src/engine/` | `Engine` 接口的默认 wasm 实现。 |
| L2 | `src/realm/` | `createRealm` 及会话语义。 |
| L3 | `src/surface/` | 面向 LLM 的文本与 spec 生成，纯函数。 |
| — | `src/ports.ts` | 所有接口与类型。零依赖，调用方只需 `import type`。 |

---

## 4. L0 / L1：步进状态机与 Engine 契约

### 4.1 步进模型

C 侧**从不等待 JS**。JS 驱动一个 step 循环：

```ts
type StepResult =
  | { type: "done"; value: Json }
  | { type: "error"; message: string; traceback: string; line?: number }
  | { type: "pending"; calls: HostCall[] }          // 一批调用；parallel 会一次交出多个
  | { type: "budget"; which: "instructions" | "memory" | "time" };

interface HostCall {
  id: number;        // 本 run 内唯一，用于喂回结果
  handle: number;    // defineHandles 注册的 tool 句柄
  args: Json;        // 已解码的入参
  line: number;      // 调用所在行，C 侧用 lua_getinfo 取得
}
```

- **一次 tool 调用只过两次边界**：交出调用请求一次，喂回结果一次。
- 数据是线性内存中的 JSON 字节，**不使用 proxy**。
- 调用所在行号在 C 侧用 `lua_getinfo` 拿到，不需要额外往返。

### 4.2 Engine 接口

Engine 是接口，同时提供默认实现。没有全局单例，分片策略由调用方决定。

```ts
type MaybePromise<T> = T | Promise<T>;

interface Engine {
  createState(limits: Limits, stdlib: StdlibSpec): MaybePromise<StateId>;
  freeState(state: StateId): MaybePromise<void>;

  /** 编译一段源码；同时用于判断代码能否解析（snippet 改写依赖它）。 */
  compile(state: StateId, src: string, name: string): MaybePromise<CompileResult>;

  /** 注册 tool 句柄（scope.tool → handle）。 */
  defineHandles(state: StateId, handles: HandleSpec[]): MaybePromise<void>;

  /** 设置 strict 的 _ENV，并注入 state / caps。 */
  setEnv(state: StateId, env: EnvSpec): MaybePromise<void>;

  /** 一个 run 一个协程。 */
  start(state: StateId, fn: FnRef, args?: Json[]): MaybePromise<RunId>;
  step(run: RunId, results?: HostResult[]): MaybePromise<StepResult>;
  cancel(run: RunId): MaybePromise<void>;

  readJson(state: StateId, ref: ValueRef): MaybePromise<Json>;
  stats(state: StateId): MaybePromise<EngineStats>;
}

interface HostResult {
  id: number;                               // 对应 HostCall.id
  ok: boolean;
  value?: Json;                             // ok 时
  error?: ToolError;                        // 失败时，作为结构化错误表在 Lua 侧抛出
}

declare function createWasmEngine(opts?: WasmEngineOptions): Promise<Engine>;
```

要点：

- 方法允许返回 `T | Promise<T>`。这样 Engine 可以放到 worker、独立进程或 napi 版本里，L2 不用改。
- 导出 `luajs/engine-conformance` 契约测试，供自行实现 Engine 的调用方使用。

### 4.3 Engine 与 Realm 的关系

- 一个 Engine 对应一个 wasm instance，可承载多个 Realm（每个约十几 KB）。
- wasm trap 时**整个 Engine 废弃**，上面所有 Realm 标记为需要重建（下次 run 时重新 wake）。
- 不做快照 / fork。

---

## 5. L2：Realm

### 5.1 接口

一个 session 对应一个长期存活的共享 Realm。

```ts
declare function createRealm(opts: {
  engine: Engine;
  tools: ToolHost;
  state: StateStore;
  caps: CapabilityStore;
  authorize?: Authorizer;
  observer?: Observer;
  limits?: Limits;
  stdlib?: StdlibSpec;
}): Realm;

interface Realm {
  readonly version: string;
  run(snippet: string, ctx?: RunContext): Promise<RunResult>;
  keep(spec: KeepSpec, ctx?: RunContext): Promise<KeepResult>;
  kill(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

interface RunContext {
  signal?: AbortSignal;
  limits?: Partial<Limits>;
  identifier?: string;               // 调用方用于关联脚本存档（如 eta 的 runs/）
  meta?: Record<string, unknown>;    // 原样透传给各 port
}

interface RunResult {
  ok: boolean;
  status: "ok" | "syntax" | "error" | "budget" | "cancelled" | "crashed";
  value?: Json;
  error?: RunError;
  logs: LogLine[];
  effects: Effect[];
  warnings: { path: string; line?: number; message: string }[];
  committed: { set: string[]; delete: string[] };
  stats: { instructions: number; memPeak: number; cpuMs: number; waitMs: number };
}
```

### 5.2 run 流程

```
run(snippet, ctx)
 ├─ version 变了？→ 重建（wake）
 │    新建 state → 打开白名单标准库 → 挂载 scope 的 handle
 │    → 注入 state（StateStore.load）→ caps 懒挂载
 ├─ snippet 改写
 │    先试 `return <整段>`；不行就从尾部逐行切分，
 │    用 compile 判断能否解析（同 eta 的 snippet.ts）
 ├─ 以 strict 的 _ENV 启动协程（start）
 ├─ step 循环
 │    pending → 每个 HostCall：Authorizer → ToolHost.call → Observer.effect
 │    → 结果批量喂回 step
 └─ 结束（无论何种 status）→ 对 state 做 diff 并 commit
```

Realm 的 `version` 由 `ToolHost.version()` 与 `CapabilityStore.version()` 组合而来，任一变化都触发重建。

### 5.3 strict globals

写入全局变量直接报错，错误信息提示改用 `local` 或 `state.x`。

### 5.4 并发 run

- 同一个 Realm **不排队**：每个 run 是一个协程，在 yield（tool 调用）处交错执行。
- 理由：支持 `eta.ask` 这类嵌套调用——外层 run 等待的 tool 内部又发起一次 run，排队会死锁。
- 预算按 run 计；内存上限按 Realm 计。

### 5.5 state：不回滚，按 key 做 diff

- 每个 run 结束都 commit，不论成功、出错、预算耗尽还是被取消。
- kill 时如果堆还能读，先 commit。
- 只有 trap 会丢失上次 commit 之后的写入，通过 `Observer.lifecycle({type: "trap"})` 报告。
- commit 在 run 结束时**按顶层 key 做 diff**（`state.x.y = 1` 这种写法拦截不到，所以不用写时拦截）。
- 并发 run 写同一个 key：后写（后 commit）的覆盖先写的。
- state 只存 JSON 值；函数等值在 commit 时跳过并附 warning（见 [§8.7](#87-降级规则表)）。

### 5.6 能力（caps）

- 每个能力的源码是一个 chunk，返回一个函数或函数表。keep 时可指定 `entry`（对应 eta 的 entry）。
- `caps` 用 `__index` **晚绑定**：能力之间可以互相调用，重新 keep 立即生效。
- **懒编译**：第一次访问时才编译。坏掉的源码只在访问它时报错，不影响 wake。
- 能力与 snippet 共用同一个环境。
- 同名能力取 `CapabilityStore.list()` 返回列表中的第一个。"层"的概念只存在于调用方，luajs 只用于展示。

```ts
interface KeepSpec {
  name: string;
  desc: string;
  source: string;
  entry?: string;     // 函数表中作为入口的字段
  meta?: Record<string, unknown>;
}
```

### 5.7 keep

先跑一次，成功了才调用 `CapabilityStore.save` 保存（同 eta 的 `esmrunandkeep`）。

### 5.8 scope 的启用 / 禁用

- 启用 / 禁用 scope 等价于 `ToolHost.version()` 变化，触发重建。
- run 中途要撤销，由 `ToolHost.call` 拒绝即可（Lua 侧收到 `scope_disabled` 错误）。
- luajs 本身不提供 enable / disable API。

---

## 6. Ports（由调用方实现）

全部定义在 `src/ports.ts`。

```ts
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JSONSchema = Record<string, unknown>;

interface CallSite { chunk: string; line: number }   // 如 { chunk: "run", line: 12 }

interface ToolHost {
  scopes(): ScopeDescriptor[];
  version(): string;
  call(req: {
    scope: string;
    tool: string;
    args: Json;
    at: CallSite;
    ctx: RunContext;
  }): Promise<Json>;
}

interface ScopeDescriptor {
  name: string;
  desc?: string;
  tools: ToolDescriptor[];
}

interface ToolDescriptor {
  name: string;
  desc: string;
  input: JSONSchema;
  output?: JSONSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  describe?(args: Json): string;
}

interface StateStore {
  load(): Promise<Record<string, Json>>;
  commit(diff: { set: Record<string, Json>; delete: string[] }, ctx: RunContext): Promise<void>;
}

interface CapabilityRecord {
  layer: string;
  name: string;
  desc: string;
  source: string;
  meta?: Record<string, unknown>;
}

interface CapabilityStore {
  /** 按优先级排好；同名取第一个。 */
  list(): Promise<CapabilityRecord[]>;
  save(rec: CapabilityRecord): Promise<SaveResult>;
  version(): string;
}

/** 返回 string 表示拒绝（理由），同 eta。 */
type Authorizer = (req: {
  scope: string;
  tool: string;
  args: Json;
  at: CallSite;
  ctx: RunContext;
}) => undefined | string | Promise<undefined | string>;

interface Observer {
  effect?(e: Effect, ctx: RunContext): void;
  console?(level: "log" | "warn" | "error", line: string, ctx: RunContext): void;
  lifecycle?(e: { type: "wake" | "kill" | "rebuild" | "trap"; reason?: string }): void;
}

interface Effect {
  scope: string;
  tool: string;
  status: "ok" | "failed" | "denied" | "scope_disabled";
  detail: string;      // 由 describe(args) 生成；只描述请求了什么
  line: number;
}
```

- `annotations` 和 `describe` 只透传；luajs 只用 `describe` 生成 effect 的 `detail`。

---

## 7. VM 内能力范围

### 7.1 可用

- 语言：变量、table、循环、函数、闭包、`pcall` / `error`（luajs 的替换版本，见 [§9.2](#92-pcall--xpcall)）。
- 标准库：
  - `string`（去掉 `string.dump`）、`table`、`math`、`utf8`
  - `select` / `pairs` / `ipairs` / `tostring` / `tonumber` / `type`
- luajs 提供：`parallel{...}`、`array()` / `object()`、`state`、`caps`、各 scope 下的 tool。

### 7.2 禁用

- `load` / `loadstring` / `dofile` / `require`
- `debug`、`collectgarbage`、`io`、`os`、`package`
- `setmetatable` / `getmetatable` / `rawget` 等元编程
- `coroutine`（只通过 `parallel` 间接使用）

### 7.3 预算与绕过

指令计数 hook 在 C 函数内部不会触发，所以 `string.rep`、复杂 pattern、`table.concat` 可以绕过 CPU 预算。对策：

1. 带上限的 allocator（内存预算）；
2. 包装 `string.rep`，预先检查结果长度；
3. JS 侧加墙钟硬超时。

---

## 8. 数据边界（Lua ↔ JSON）

### 8.1 思路 A：形状标记

从 JSON 解码出来的表挂一个内部元表作为形状标记，记录：

- 是 array 还是 object；
- 原始长度（数组）。

保证往返无损。用户代码看不到这个元表（`getmetatable` 不可用）。

### 8.2 思路 B：歧义路径 + schema 修正

C 侧编码时记下**有歧义的路径**（如空表、超大整数），TS 侧只沿这些路径查 schema 做修正。歧义点通常是 0 个，成本可以忽略，不需要 SIMD。

**A 和 B 一起用。**

### 8.3 空表

| 情况 | 编码结果 |
| --- | --- |
| 有形状标记 | 按标记还原 |
| 作为 tool 入参 | 按 schema |
| 其余 | 默认 `{}` |

Lua 里 `{}` 和 `[]` 是同一种表，没有性能差别；默认选 `{}` 是语义上的理由。需要 `[]` 时用 `array()`。

### 8.4 null 与数组空洞

- `null` 一律解码成 `nil`。
- 数组靠形状标记记住长度，用 `__len` 让 `#t` 正确；编码回去时空洞补 `null`。
- `ipairs` 遇到空洞会提前停止——这一点写进 surface 规则。

### 8.5 用户构造的表、key、数字

- key 恰好是 `1..n` 连续才算数组，其余编码成对象，数字 key 转成字符串。
- JSON 对象里的数字字符串 key，解码后**保持字符串**。
- 整数：在 ±2^53 以内解码成整数，其他是浮点。`print` 里出现的 `5.0` 不做修饰。

### 8.6 字符串与输出

- 非法 UTF-8 替换成 U+FFFD。
- 编码时对象 key 排序（输出稳定）。

### 8.7 降级规则表

| 情况 | tool 入参 | state | 返回给模型的 value |
| --- | --- | --- | --- |
| 超出 2^53 的整数 | 按 schema；无 schema 则转字符串 + warning | 转字符串 + warning | 转字符串 |
| NaN、inf | **报错** | 转 `null` + warning | 转字符串 `"NaN"` 等 |
| 布尔值作 key | 转字符串 + warning | 转字符串 + warning | 转字符串 + warning |
| 表或函数作 key | **报错** | 跳过 + warning | 渲染成 `"<table>"` |
| 函数、userdata 作值 | **报错** | 跳过 + warning | 渲染成 `"<function>"` |
| 循环引用 | **报错** | 跳过该 key + warning | 渲染成 `"<cycle>"` |
| 深度或体积超限 | **报错** | 跳过 + warning | 截断并标注 |

只有"tool 入参"一列会报错，符合 [§2.2](#22-不因表示方式让一次-run-失败)。

---

## 9. 错误模型

### 9.1 status

| status | 含义 | pcall 能否接住 |
| --- | --- | --- |
| `syntax` | 无法解析，一行都没执行 | — |
| `error` | 运行时错误或 tool 错误 | 能 |
| `budget` | 预算耗尽（指令 / 内存 / 时间） | 不能 |
| `cancelled` | 被 signal 取消或 kill | 不能 |
| `crashed` | wasm trap，Realm 已重建 | — |

### 9.2 pcall / xpcall

- 用 luajs 自己的版本替换：遇到预算、取消的哨兵值（以及内存错误）就再抛出去。
- 预算耗尽后 hook 保持标志，每次触发都再抛一次，防止被循环 pcall 吞掉。

### 9.3 tool 失败

tool 失败时直接抛出结构化错误表，带 `__tostring`。**不采用 `nil, err` 的写法。**

```lua
-- 抛出的错误值形状
{
  kind = "tool_failed" | "denied" | "scope_disabled",
  tool = "github.list_issues",
  message = "...",
  data = ...,          -- 可选，host 附带的结构化信息
}
```

```lua
local ok, err = pcall(github.create_issue, { repo = "a/b", title = "x" })
if not ok and err.kind == "denied" then ... end
```

### 9.4 traceback

- 只保留用户代码的帧。
- chunk 命名：snippet 为 `run:12`，能力为 `caps.name:3 (layer)`。
- 附上出错的那一行源码。

### 9.5 错误提示表（L3）

以数据形式提供、可扩展，放在 L3。覆盖常见的 JS 习惯：

| 触发 | 提示 |
| --- | --- |
| `!=` | 用 `~=` |
| `+` 拼接字符串 | 用 `..` |
| `.length` | 用 `#t` |
| 写全局变量 | 用 `local` 或 `state.x` |
| 访问 tool 返回值里的 nil 字段 | JSON 的 null 解码为 nil，字段可能缺失 |
| `'end' expected` | 检查 `if/for/function` 是否配对 `end` |

### 9.6 formatResult

默认实现，eta 可替换。参照 eta，按顺序输出：

1. 值或错误（错误含出错行与提示）；
2. warnings；
3. console / logs（保留尾部）；
4. effects：
   - 不论成功失败一律全部列出，格式同 eta：`[status] name detail (line N)`；
   - `ok` 不加前缀；`detail` 只写请求了什么，不写返回了什么；
   - run 失败时在 effects 标题后加 `(not rolled back)`；
5. committed 的 state key。

超长时截断；结构化结果里带上完整文本，是否写文件由调用方决定。脚本是否保存（eta 的 `runs/`）也由调用方决定，用 `identifier` 对接。

示例：

```
error: run:4: attempt to index a nil value (field 'user')
  4 | local name = issue.user.login
  hint: JSON null 会解码为 nil，字段可能缺失

effects (not rolled back):
  github.list_issues repo=a/b (line 2)
  [failed] github.get_user login=x (line 3)

state committed: last_repo
```

---

## 10. L3：surface（给 LLM 看）

全部是纯函数。

### 10.1 静态与动态分离

- **静态部分**：规则，放在工具描述里，保持稳定以命中 prompt cache。
- **动态部分**：scope、caps、state 的 key。首次全量，之后只发 delta。

### 10.2 静态规则

只写和模型直觉不一样的地方，约十来条：

1. 最后一个表达式就是结果。
2. `local` 不跨 run；写全局会报错，要跨 run 保存请用 `state`。
3. tool 看起来是同步的，接收一个 table 参数，失败时抛错；用 `parallel{...}` 并发。
4. JSON `null` → `nil`；遍历数组用 `for i = 1, #t`（`ipairs` 遇到空洞会停）。
5. `#s` 是字节数；截断字符串用 `utf8.offset`。
6. 下标从 1 开始；不等于是 `~=`；字符串拼接是 `..`。
7. JSON 对象的 key 保持字符串（数字 key 也是字符串）。
8. 空表发出去是 `{}`，要 `[]` 用 `array()`。
9. 可用的只有列出的这些。
10. 失败的 run 不会撤销已经做过的 tool 调用。

规则与错误提示表（[§9.5](#95-错误提示表l3)）放在同一处维护，互相对应。

### 10.3 签名

紧凑的类 TS 写法，不用 LuaLS 注解：

```
github.list_issues{repo: string, state?: "open"|"closed"} -> {number: integer, title: string}[]
github.create_issue{repo: string, title: string, body?: string} -> any
```

- 没有 output schema 就写 `-> any`。
- 签名**永远全部列出**：不设阈值、不分档、不做 `help()` 按需查询。tool 多了 prompt 变长，由注册 tool 的人负责。
- caps 列出名字、签名、desc 和所在层。
- state 只列 key 和粗略类型。

### 10.4 导出

```ts
declare function staticRules(): string;
declare function describeSurface(prev: SurfaceSnapshot | undefined, next: SurfaceSnapshot): string; // 首次全量，之后 delta
declare function formatResult(r: RunResult, opts?: FormatOptions): { text: string; full: string; truncated: boolean };
declare const hints: HintRule[];   // 错误提示表，可扩展

/** 只导出 schema 与描述，由 eta 自己注册和执行。 */
declare function toolSpecs(): {
  luarun: ToolSpec;
  luarunandkeep: ToolSpec;
  list_capabilities: ToolSpec;
  read_state: ToolSpec;
};
```

---

## 11. 待讨论

- **parallel 的语义**：一个分支失败时其他分支怎么办（继续等完 / 取消未返回的 / 结果里如何表示）；并发上限。
- **原语清单**：`parallel`、`array()`、`state` 等是否保留、是否增加 helper，以 [BENCH.md](BENCH.md) 评测产出的原语候选清单为依据。
- **keep 的命名与覆盖规则**：eta 的做法是同名拒绝；luajs 是否跟随，以及与"同名取列表第一个"的关系。
