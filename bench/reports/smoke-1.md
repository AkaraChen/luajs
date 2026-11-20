# smoke-1 报告：codemode 评测框架第一轮 smoke

- 日期：2026-11-20（UTC 05:58–06:05）
- 矩阵：8 题（C1–C8 各 1 题）× 3 个模型（deepseek-v4.1-flash、glm-5.3、qwen3.8-flash）× {js, lua-interim} × 1 次 = **48 个 episode，全部跑完**
- provider：opencode go（OpenAI 兼容接口）；temperature 0.6、max_tokens 16000、每题最多 4 轮、思考模式按模型默认
- harness_version：common 1、js 1、lua-interim 1；mock 世界 core-v1（mock_version 1，seed 4217）
- **总费用 $0.1154**（账本 134 个真实请求，没有重复付费的请求），预算上限 $5，没有触发预算护栏
- Lua 组用的是临时运行时 **lua-interim**（wasmoon + prelude），不是 luajs，结论只作参考；偏差见 §8

> 这一轮 smoke 的目的是验证框架（端到端能跑通、断点恢复、判分、费用估算、surface 有没有问题），**不用于得出 Lua vs JS 的结论**：每格只有 1 次，题目也只有 8 道。

---

## 1. 结论速览

1. **框架能端到端跑通**：48/48 跑完，没有 infra_error；进程被 `kill -9` 后续跑，只发了还没发过的请求（§3）。
2. **按设计的严格判分有大量误判**：严格判分通过 34/48，人工逐条复核后有 **13 条是误判**（模型其实答对了）。原因都一样：判分取"最后一次成功 run 的返回值"，但模型经常 (a) 先算出答案、再跑一次"核对"的 run，(b) 把答案包在调试对象里返回（如 `{statuses, top}`），(c) 只在最后的文字回复里给出答案。我加了一个宽松判分，和严格判分并列报告（§4.2），宽松判分 47/48，人工复核和它的结论一致。**这是进入 pilot 前最重要的问题**（§7）。
3. **发现两个 harness 自身的问题**，都让模型多花了一轮：JS 运行时把"最后一个表达式"改写成 return 时，对 `({a, b});` 这种带括号的表达式改写错了（2 次）；Lua 的 `array(t)` 会把 t 包一层，而不是把 t 转成数组（1 次）。
4. **发现一个两种语言都有的真实坑：tool 的 scope 名被同名局部变量遮蔽**。例如 `local orders = orders.search{...}` 之后再调 `orders.get` 就是调 nil；JS 里 `const orders = await orders.search(...)` 会报 TDZ 错误。一共出现 5 次（JS 3 次、Lua 2 次）。deepseek 的 Lua 组因为这个用完了 4 轮，是 48 条里唯一的真失败。
5. **扇出题**：6 个 episode 全部写成**顺序循环**，每个都调了 20 次 orders.get。没有模型尝试 coroutine、异步写法或自己拼批量调用。另外，qwen 在 C4 的 JS 代码里自发用了 `Promise.all`。
6. **费用比 BENCH.md 的估算低一个数量级**：每个 episode 平均约 2.5k–4.9k 输入、300–700 输出 token；按实测均值估算，full 阶段（720 episode/模型）**三个模型合计约 $5.2**（§5）。

---

## 2. 每个 episode 的结果

"严格"是 BENCH.md §1.4 原定的判分方式（取最后一次成功 run 的返回值）；"宽松"是这一轮新加的（§4.2），括号里写的是宽松判分从哪里找到了答案。"runs"列是每次 run 的状态和错误标签。费用用的是 provider 返回的 `usage.opencode.list_cost`（标价）。

### 2.1 按模型 × 语言汇总

| 模型 | 语言 | 严格通过 | 宽松通过 | 平均轮数 | 输入 tok | 其中缓存命中 | 输出 tok | 其中思考 | 费用 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-v4.1-flash | js | 5/8 | 8/8 | 2.38 | 21856 | 10496 | 2266 | 611 | $0.0062 |
| deepseek-v4.1-flash | lua-interim | 5/8 | 7/8 | 2.38 | 21351 | 10368 | 2624 | 824 | $0.0065 |
| glm-5.3 | js | 8/8 | 8/8 | 2.75 | 21962 | 9600 | 4132 | 2537 | $0.0380 |
| glm-5.3 | lua-interim | 6/8 | 8/8 | 2.63 | 27649 | 15168 | 6994 | 5141 | $0.0522 |
| qwen3.8-flash | js | 4/8 | 8/8 | 3.13 | 34467 | 8192 | 3706 | 1282 | $0.0058 |
| qwen3.8-flash | lua-interim | 6/8 | 8/8 | 3.50 | 44136 | 16384 | 4783 | 1632 | $0.0067 |
| **合计** | | **34/48** | **47/48** | 2.79 | 171421 | 70208 | 24505 | 12027 | **$0.1154** |

### 2.2 逐条（48 条）

"人工复核"列：✔ = 判分正确；**误判** = 严格判分判错了（模型其实答对了）；**harness** = 失败的 run 是 harness 的 bug 造成的。

| # | 题 | 模型 | 语言 | 严格 | 宽松 | 轮数 | runs（状态:标签） | 输入/输出 tok | 费用 | 严格判分的失败原因 | 人工复核 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | C1 assignee | deepseek | js | ✅ | ✅ | 2 | ok | 1911/77 | $0.0004 | | ✔ |
| 2 | C1 assignee | deepseek | lua | ✅ | ✅ | 2 | ok | 2051/92 | $0.0005 | | ✔ |
| 3 | C1 assignee | glm | js | ✅ | ✅ | 2 | ok | 1625/102 | $0.0020 | | ✔ |
| 4 | C1 assignee | glm | lua | ❌ | ✅ run_value | 3 | ok, ok | 2862/150 | $0.0028 | 第 2 次 run 返回整个 issue | **误判**：第 1 次 run 返回 null，回复"没有指派人" |
| 5 | C1 assignee | qwen | js | ❌ | ✅ final_text | 2 | ok | 2151/235 | $0.0004 | run 返回整个 issue | **误判**：回复"null — … 没有指派人" |
| 6 | C1 assignee | qwen | lua | ❌ | ✅ run_value | 3 | ok, ok | 3289/204 | $0.0005 | 第 2 次 run 返回 `{title, state}` | **误判**：同 #4 |
| 7 | C2 top5 | deepseek | js | ❌ | ✅ nested | 4 | ok, error:scope_shadow, ok, ok | 6521/786 | $0.0020 | 返回 `{statuses, top}` | **误判**：top 正确；第 4 轮用完，没有最终回复 |
| 8 | C2 top5 | deepseek | lua | ❌ | ✅ nested | 2 | ok | 2870/768 | $0.0015 | 返回 `{since, before, result}` | **误判**：result 正确，回复里也给了正确的 JSON |
| 9 | C2 top5 | glm | js | ✅ | ✅ | 3 | error:scope_shadow, ok | 4901/1775 | $0.0128 | | ✔ |
| 10 | C2 top5 | glm | lua | ✅ | ✅ | 3 | ok, ok | 9073/3915 | $0.0237 | | ✔ |
| 11 | C2 top5 | qwen | js | ❌ | ✅ nested | 4 | ok ×4 | 6630/851 | $0.0011 | 返回 `{top5, next, …}` | **误判**：top5 正确；4 轮里有 3 轮在做探查，用完 4 轮，没有最终回复 |
| 12 | C2 top5 | qwen | lua | ❌ | ✅ nested | 4 | ok ×4 | 6680/1304 | $0.0012 | 返回 `{all, …}` | **误判**：同 #11 |
| 13 | C3 fan-out | deepseek | js | ❌ | ✅ final_text | 2 | ok | 2793/297 | $0.0009 | run 返回 20 条明细 | **误判**：回复里给出 `[1104, 1108, 1113, 1117, 1118]` |
| 14 | C3 fan-out | deepseek | lua | ❌ | ❌ | 4 | error:scope_shadow, ok, ok, ok | 5336/761 | $0.0015 | 只返回了明细 | ✔ 真失败：被 `local orders` 遮蔽搞糊涂，花 2 轮排查，用完 4 轮也没给出 id 列表 |
| 15 | C3 fan-out | glm | js | ✅ | ✅ | 3 | error:scope_shadow, ok | 3220/461 | $0.0047 | | ✔ |
| 16 | C3 fan-out | glm | lua | ❌ | ✅ nested | 3 | error:scope_shadow, ok | 4634/1062 | $0.0095 | 返回 `[[1104,…]]` | **误判 + harness**：写了 `array(ids)`，lua-interim 的 `array()` 是"用参数构造数组"，把 ids 包了一层；回复里的答案正确 |
| 17 | C3 fan-out | qwen | js | ❌ | ✅ nested | 3 | ok, ok | 8471/786 | $0.0014 | 返回 `{refundableIds, details}` | **误判** |
| 18 | C3 fan-out | qwen | lua | ✅ | ✅ | 4 | ok ×4 | 13481/650 | $0.0015 | | ✔（第 4 轮的 run 才给出答案，没有最终回复） |
| 19 | C4 refund | deepseek | js | ✅ | ✅ | 2 | ok | 2264/426 | $0.0009 | | ✔ 没有调用 refund，回复"不予退款" |
| 20 | C4 refund | deepseek | lua | ✅ | ✅ | 2 | ok | 2296/401 | $0.0009 | | ✔ 同上 |
| 21 | C4 refund | glm | js | ✅ | ✅ | 3 | error:harness_rewrite_bug, ok | 3300/811 | $0.0056 | | ✔，但第 1 次 run 失败是 **harness** 的 bug |
| 22 | C4 refund | glm | lua | ✅ | ✅ | 2 | ok | 2070/627 | $0.0039 | | ✔ |
| 23 | C4 refund | qwen | js | ✅ | ✅ | 3 | ok, ok | 3956/764 | $0.0008 | | ✔（自发用了 `Promise.all`） |
| 24 | C4 refund | qwen | lua | ✅ | ✅ | 3 | ok, ok | 4543/1015 | $0.0010 | | ✔（手写了 ISO 时间到 epoch 的换算） |
| 25 | C5 截断 | deepseek | js | ❌ | ✅ nested | 2 | ok | 1676/179 | $0.0003 | 返回 `JSON.stringify({len, head})` | **误判**：head 正确，回复正确 |
| 26 | C5 截断 | deepseek | lua | ❌ | ✅ nested | 2 | ok | 1892/199 | $0.0006 | 返回 `{chars, len, sub}` | **误判**：用 utf8.offset 截断，结果正确 |
| 27 | C5 截断 | glm | js | ✅ | ✅ | 3 | ok, ok | 2457/311 | $0.0031 | | ✔ |
| 28 | C5 截断 | glm | lua | ✅ | ✅ | 3 | ok, ok | 3171/816 | $0.0057 | | ✔ |
| 29 | C5 截断 | qwen | js | ❌ | ✅ run_value | 4 | ok ×3 | 4112/252 | $0.0006 | 最后一次 run 返回 `[50, s]` | **误判**：第 2 次 run 已经正好返回答案 |
| 30 | C5 截断 | qwen | lua | ✅ | ✅ | 4 | ok, error:type, ok, ok | 5299/742 | $0.0009 | | ✔（中间把 `utf8.offset(c, "\n")` 写错了一次） |
| 31 | C6 清空 labels | deepseek | js | ✅ | ✅ | 2 | ok | 2005/235 | $0.0007 | | ✔ 传 `[]` |
| 32 | C6 清空 labels | deepseek | lua | ✅ | ✅ | 2 | ok | 1925/176 | $0.0006 | | ✔ 传 `array()` |
| 33 | C6 清空 labels | glm | js | ✅ | ✅ | 3 | error:harness_rewrite_bug, ok | 2626/497 | $0.0051 | | ✔，第 1 次 run 失败是 **harness** 的 bug |
| 34 | C6 清空 labels | glm | lua | ✅ | ✅ | 2 | ok | 1656/246 | $0.0025 | | ✔ 传 `array()` |
| 35 | C6 清空 labels | qwen | js | ✅ | ✅ | 4 | ok ×3 | 4293/303 | $0.0005 | | ✔ |
| 36 | C6 清空 labels | qwen | lua | ✅ | ✅ | 3 | ok, ok | 3321/293 | $0.0005 | | ✔ 传 `array()` |
| 37–42 | C7 限流 | 全部 6 组 | | ✅ | ✅ | 3 | error:tool_error_unhandled, ok | 2262–3006 / 110–376 | $0.0005–0.0030 | | ✔ 6 组表现相同：第 1 次 run 没有 pcall/try，被限流后报错；下一轮原样重跑就成功了，每组都只调了 2 次 |
| 43–47 | C8 标题 | 除 qwen-lua 外 5 组 | | ✅ | ✅ | 2 | ok | 1571–2049 / 54–349 | $0.0004–0.0017 | | ✔ |
| 48 | C8 标题 | qwen | lua | ✅ | ✅ | 4 | invalid_call, error:unknown_api, ok | 4517/199 | $0.0005 | | ✔；qwen 先直接调用了一个叫 `issues.get` 的 function（没有通过 run），然后写了 `scope.issues.get`，第 3 轮才写对 |

（逐条的完整表格、代码和结果可以用 `node analysis/smoke.js --episodes` 从 `runs/` 重新生成；`runs/` 不进仓库。）

### 2.3 失败 run 的错误标签

| 标签 | JS | Lua | 说明 |
| --- | --- | --- | --- |
| tool_error_unhandled | 3 | 3 | 全部是 C7 的第一次 run（设计如此：被限流后由下一轮重跑） |
| scope_shadow | 3 | 2 | 局部变量和 tool 的 scope 同名（新标签，本轮发现） |
| harness_rewrite_bug | 2 | 0 | JS 运行时把最后一个表达式改写成 return 的 bug（§7） |
| unknown_api | 0 | 1 | qwen 写了 `scope.issues.get` |
| invalid_call | 0 | 1 | qwen 直接调用了 `issues.get` function，没有通过 run |
| type | 0 | 1 | `utf8.offset(c, "\n")` |
| js_ism / nil_null / utf8 / budget | 0 | 0 | 本轮没有出现 |

另外两点：C1 的 6 组没有一组对 null 的 assignee 做索引而崩掉；C5 的 Lua 组全部用了 `utf8.offset`，没有一组按字节截断，答案里也没有出现 U+FFFD。这一轮的两个"坑"都没有触发，规则 4、5 可能已经足够提示了，要等 pilot 有更多题再看。

---

## 3. 中断后续跑的实测

做法：第一个进程（并发 6）跑到第 19 个格子完成时，由一个监视脚本 `kill -9` 掉（退出码 137）。这时还有其他 episode 正在进行。然后直接重新执行 `node harness/cli.js run --stage smoke`。

| 时刻 | 结果行 | 账本中 smoke 请求数 | 缓存文件数 |
| --- | --- | --- | --- |
| kill 之后、续跑之前（06:02:00） | 19 | 58 | 61（含 3 个 ping） |
| 续跑结束 | 48 | 134 | 137 |

续跑进程的输出摘要（`runs/run2.log`）：

```
run smoke: 48 cells, done 19, to run 29
budget $5.0000, spent before this process $0.0503
[2/29] PASS c4-refund-expired-01 glm-5.3 js r0 turns=3 cache=2/3 cost=$0.0056
[3/29] PASS c4-refund-expired-01 qwen3.8-flash js r0 turns=3 cache=2/3 cost=$0.0008
...
---- summary ----
cells finished this process: 29 (pass 26), infra errors: 0, not started: 0
llm: cache_hits=4 new_requests=76 duplicate_requests=0 retries=17 failed_requests=0
spent this process $0.0650; stage total $0.1154 / budget $5.0000
```

逐条核对账本（脚本对照 `runs/ledger.jsonl` 和结果行）：

- 被杀进程写出的 19 行结果一共用了 54 个请求；账本里另外还有 **4 个请求已经付费，但不属于任何结果行**，它们来自被杀时正在进行的 2 个 episode（C4 glm-js 和 C4 qwen-js，各有前 2 轮）。
- 续跑时这两个 episode 的前 2 轮都**命中了缓存**（`cache=2/3`），一共 4 次命中，正好就是这 4 个请求；只有第 3 轮发了新请求。
- 续跑进程新发了 76 个请求，**其中没有一个的 llm_key 在 kill 前的账本里出现过**；账本里 134 个 smoke 请求的 llm_key 全部不同（`bench status`：duplicate llm_keys in ledger (paid twice): 0）。
- 确定性自检 `selfcheck`：48 个格子各用缓存离线重放两次，llm_key 序列都和结果行一致（48 deterministic, 0 mismatched）。
- 改判分逻辑之后的 `regrade`：离线重放 48 格，**命中缓存 134 次，新请求 0 个**，花费 $0。

结论：缓存命中数 > 0，没有重复请求。

顺带记录两件事：续跑时 glm-5.3 遇到 17 次 HTTP 429（限流），都在客户端退避重试后成功，没有产生 infra_error。被 kill 的进程来不及写 `runs/process-log.jsonl`（这个文件在进程正常结束时才写），所以它的统计只能从账本里推算（就是上面的核对）。

---

## 4. 判分复核

### 4.1 逐条人工复核的结论

48 条记录都对照代码、run 的输出和最终回复逐条看过（见 §2.2 的"人工复核"列）：

- **严格判分**：判对 35 条（34 条通过 + 1 条真失败，即 #14），**误判 13 条**，都是"模型答对了，但被判为失败"。没有发现"答错了却被判通过"的情况。C4 的 6 条最终回复都明确说"不退款"，状态 diff 也确认没有写入；C6 的状态 diff 都正好是 `/users/u_17/labels: []`。
- **宽松判分**：48 条都和人工复核一致。
- 状态 diff 和 effects 两项检查都没有误判。

13 条误判可以分为三类：

| 类型 | 条数 | 例子 |
| --- | --- | --- |
| 答案包在调试或上下文对象里 | 8 | `{statuses, top}`、`{since, before, result}`、`{refundableIds, details}`、`JSON.stringify({len, head})` |
| 答对以后又跑了一次核对用的 run | 3 | C1：先返回 null，再返回整个 issue |
| 答案只出现在最终回复里 | 2 | C1 qwen-js、C3 deepseek-js |

另外 #16 叠加了 harness 的 `array()` 问题。还有 3 条（#7、#11、#12）到第 4 轮还在探查，第 4 轮的 run 算出了答案，但模型没有机会再写最终回复。

### 4.2 宽松判分（本轮新增，严格判分照旧）

`harness/grade/grade.js` 里的 `checkAnswerLenient`：期望值等于任意一次成功 run 的返回值，或者等于嵌套在返回值里的某个子值（字符串形式的 JSON 也会解析后再找），或者出现在最终回复里，都算通过。期望值是 null 时不在嵌套子值里找，因为任何对象里都可能有 null。结果行同时记录 `pass`（严格）、`pass_lenient` 和 `lenient_via`。这个改动只涉及判分代码，按 BENCH.md §4.7，用 `regrade` 离线重放即可，不需要重新请求模型。

宽松判分只是一个兜底的对照指标，不能取代严格判分：期望值的子串碰巧出现在别处时可能误判为通过，本轮没有发生。根本的解决办法见 §7 第 1 条。

---

## 5. 费用：实测与 full 阶段的重新估算

| 模型 | episode 数 | 平均每 episode | 平均输入 tok | 平均输出 tok | full 估算（720 episode/模型） |
| --- | --- | --- | --- | --- | --- |
| deepseek-v4.1-flash | 16 | $0.00079 | 2700 | 306 | $0.57 |
| glm-5.3 | 16 | $0.00564 | 3101 | 695 | $4.06 |
| qwen3.8-flash | 16 | $0.00078 | 4913 | 531 | $0.56 |
| **合计** | 48 | $0.0024 | 3571 | 511 | **$5.19** |

- full 阶段的规模按 BENCH.md §5：120 题 × 2 种语言 × 3 次 = 每个模型 720 个 episode。加上约 10% 的试跑，**约 $5.7**。
- 考虑到 pilot 和 full 的题会更难，轮数和输出 token 都可能增加，**建议按 2 倍余量估计，约 $10–12**，manifest 里的 full 预算 $80 绰绰有余。
- 和 BENCH.md §5 估算（$60–70）的差别来自三点：
  1. 实际每个 episode 只有约 3.6k 输入、0.5k 输出 token，而原来的假设是 12k / 3k；
  2. 这一轮用的是 qwen3.8-flash（$0.15 / $0.47 每百万 token），原估算用的是 qwen3.8-max（$2 / $6），qwen 那一份从约 $33 降到约 $0.6；
  3. prompt 缓存生效了：41% 的输入 token 命中缓存。
- 价格来源：opencode go 的 `/models`（`harness/pricing.yaml`，as_of 2026-11-20）。实际计费用的是响应里的 `usage.opencode.list_cost`，它和按价格表算出来的结果一致。deepseek 在工作日 UTC 01–04 点、06–10 点价格翻倍，本轮正好在 06 点后，list_cost 已经包含了这个倍率。opencode go 是订阅制，以上都是"标价等价"费用，实际扣的是订阅额度。

---

## 6. 扇出题（C3）的写法分类

surface 里没有提 `parallel` 或并发，只观察模型自己怎么写：

| 模型 | 语言 | 写法 | orders.get 调用数 | 严格 | 宽松 |
| --- | --- | --- | --- | --- | --- |
| deepseek-v4.1-flash | js | 顺序循环（`for … of` 里 await） | 20 | ❌ | ✅ |
| deepseek-v4.1-flash | lua-interim | 顺序循环 | 20 | ❌ | ❌ |
| glm-5.3 | js | 顺序循环 | 20 | ✅ | ✅ |
| glm-5.3 | lua-interim | 顺序循环 | 20 | ❌ | ✅ |
| qwen3.8-flash | js | 顺序循环（id 列表是手抄进代码的） | 20 | ❌ | ✅ |
| qwen3.8-flash | lua-interim | 顺序循环，借 `state` 分两次 run 完成 | 20 | ✅ | ✅ |

- **顺序循环 6/6**；coroutine 或异步写法 0；自己拼批量调用 0；把调用逐个手写展开 0。
- JS 组 surface 里没有提 `Promise.all`，在 C3 里也没有一个模型用；但 qwen 在 C4（只有 2 个独立调用）里自发写了 `Promise.all([time.now(), orders.get()])`。
- 只看这一轮，模型在没有提示时不会主动并发，扇出写成顺序循环也都能正确完成。是否提供 `parallel`、优先级多高，要等 pilot 的 C3 题多一些、并且测一下 20 次串行调用的实际耗时再定。
- 分类由 `harness/grade/classify.js` 的规则做，6 条都人工核对过，分类正确。

---

## 7. 进入 pilot 前要修的问题

按优先级排列：

1. **判分取答案的约定（最重要）**。"最后一次成功 run 的返回值"和模型的实际习惯不符，误判率 13/48。可选的修法：
   - (a) 题面统一加一句"最终答案放在最后一次 run 的返回值里，只返回答案本身"。改动最小，但核对用的 run 仍然会覆盖答案。
   - (b) 增加一个 `answer` 原语或 tool（例如 `answer(x)`），以最后一次调用为准。这也和"原语该给哪些"的问题有关。
   - (c) 让模型在最终回复里按约定格式给出 JSON 答案，判分以它为准。

   我倾向 (b)，在 pilot 里和 (a) 做一次对照。不论选哪种，宽松判分都继续作为参考指标报告。
2. **修 JS 运行时把最后一个表达式改写成 return 的 bug**（`harness/runtimes/js.js` 的 `prepareJs`）。acorn 的 ExpressionStatement 不包含外层括号，`({a, b});` 会被改写成 `(return ({a, b}))`。应该在语句的起点插入 `return (`。修完 bump `harness_version.js`。
3. **决定 `array()` 的语义**。现在的实现是"用参数构造数组"（`array(1, 2)` → `[1, 2]`），模型会把它当作"把已有的表转成数组"（`array(ids)`）。建议 luajs 定为：`array()` 是空数组，`array(t)` 把 t 标记成数组并返回 t，并在 ARCHITECTURE §8.3 和 surface 规则 8 里写清楚。修完 bump `harness_version.lua-interim`。
4. **scope 名被局部变量遮蔽**（48 条里有 5 次）。可以考虑：
   - 在 surface 里加一条规则："不要用 scope 名（如 orders）作变量名"；
   - 在错误提示表里加一条：遇到 `attempt to call a nil value (field 'get')` / `Cannot access 'orders' before initialization`，并且同名局部变量存在时，给出针对性提示；
   - 或者改成单数、不容易撞名的 scope 名。

   这个问题需要在 ARCHITECTURE 的 surface 层面做决定，建议作为 pilot 的一个观察项。
5. **mock 的字段名不能用 Lua 关键字**。写 oracle 测试时发现 `orders.search{until = …}` 在 Lua 里是语法错误（`until` 是关键字），已经改名为 `before`。真实 API 里也会有 `end`、`until`、`function` 这类字段名，建议在 pilot 里专门出一道 C6 题测 `["until"] = …` 的写法，并在提示表里加一条。
6. **第 4 轮用完时模型没有机会给出最终回复**（#7、#11、#12、#14、#18）。qwen 喜欢先探查数据，经常用满 4 轮。可以考虑把上限放宽到 5 轮，或者在第 4 轮的 tool result 后面加一句"这是最后一轮"。改 surface 要 bump `harness_version.common`。
7. **glm-5.3 的并发限流**：续跑时出现 17 次 429。pilot 要么在 manifest 里给每个模型单独设并发上限（glm 设 2–3），要么全局并发降到 4。
8. **被 kill 的进程不会留下统计**：可以让账本按进程写 `pid`，这样续跑报告能直接给出被杀进程的数字，不用像 §3 那样事后推算。
9. **错误标签补充规则**：`scope_shadow` 和 `harness_rewrite_bug` 是本轮新加的；`invalid_call`（不通过 run，直接调用 tool 名）在 JSON 基线组里可能更常见，值得单独统计。
10. **题目本身**：这一轮 C1 和 C5 的坑都没有触发（6/6 都避开了）。pilot 每类要有"有一个坑"和"有两个坑"的题；C7 也要加"第二次还失败"或"被拒绝"（denied）的变体，不然看不出模型会不会正确放弃。

---

## 8. 临时 Lua 运行时（lua-interim）和 ARCHITECTURE 的差距

lua-interim 是 Lua 5.4（wasmoon 1.16）加上 `harness/runtimes/lua/prelude.lua`，尽量模拟 ARCHITECTURE 的 surface。做到的：

- strict globals：写全局变量报错，提示改用 local 或 state；读未定义的全局也报错（`undefined global 'x'`），这一点比 ARCHITECTURE §5.3 更严格。
- 禁用 io、os、load、loadstring、dofile、require、debug、coroutine、package、collectgarbage、setmetatable / getmetatable / raw* 和 `string.dump`；`math.random` 也去掉了，因为它不确定。
- 最后一个表达式作为结果：先试 `return <整段>`，不行再从尾部逐行切分，要求前缀和 `return <尾部>` 都能单独编译。
- tool 看起来是同步的；失败时抛出结构化错误表 `{kind, tool, message, data}`，带 `__tostring`，pcall 能接住。
- 预算：指令计数 hook，pcall/xpcall 接不住；每次 run 最多调用 200 次 tool；内存上限 256MB。
- `state` 跨 run 保存，按顶层 key 做 diff 后提交，失败的 run 也会提交。
- 数据边界：null 解码成 nil；数组带形状元表，`#t` 能算出有空洞的数组长度，ipairs 遇到空洞会停；数字 key 保持字符串；空表编码成 `{}`，tool 入参按 schema 修正；有 `array()` 和 `object()`；整数和浮点数按 §8.5 区分；非法 UTF-8 替换成 U+FFFD；编码时对象 key 排序。

**做不到或和 ARCHITECTURE 不同的地方：**

| 项目 | 差别 | 影响 |
| --- | --- | --- |
| 形状标记的实现 | 用普通 Lua 元表和弱表记录长度，而不是 luajs 的内部标记 | 用户不能读写元表，看不出差别；但 `next` 是原生的 |
| 数组末尾的 null | 解码后 `#t` 会收缩，末尾的 null 编码回去时会丢失 | C6 题如果涉及末尾 null 会有偏差 |
| `pairs` 顺序 | 改成确定性的顺序（按 key 的 FNV hash 排序），既不是插入序也不是排好序的 | 必须这样做：原生 Lua 每个 state 的字符串 hash 种子不同，pairs 顺序会变，缓存重放就不确定了。代价是原生 Lua 里顺序相关的 bug 在这里表现为"固定的错误顺序" |
| `array(...)` | 用参数构造数组，`array(t)` 会把 t 包一层 | 本轮 #16 因此失败，见 §7 第 3 条 |
| 空表作为 tool 入参 | 按 schema 修正（`labels = {}` 会编码成 `[]`） | 按 ARCHITECTURE §8.3 实现，所以 Lua 组在 C6 不会因为 `{}` 失败；本轮 3 个模型都写了 `array()` |
| 错误 traceback | 只给出错的行和这一行的源码，没有完整的调用帧 | §9.4 要求只保留用户帧，这里更简化 |
| 提示表 | 简单的正则规则（`harness/surface/rules.js`），不是 luajs L3 的实现 | 提示的文字和触发条件以后会变 |
| 降级规则表（§8.7） | 实现了 NaN/inf、函数、循环引用、布尔或表作 key 的处理；超过 2^53 的整数和深度/体积超限没有实现 | 本轮的题没有涉及 |
| `parallel` | 不提供（smoke 的决定） | — |
| 并发 run、keep、caps、Authorizer 拒绝 | 没有实现；故障注入（限流、denied）在 ToolHost 里做，按参数匹配 | 本轮只用到了限流 |
| 内存预算 | 用 wasmoon 的 `setMemoryMax`；`string.rep` 没有预先检查 | 本轮没有涉及 |

JS 组的运行时（node:vm）：每次 run 新建 context；最后一个表达式作为结果（acorn 改写）；tool 是 async 函数，失败时抛出带 kind/tool/message/data 字段的 Error；没有 require、import、process、定时器、fetch，eval 和 new Function 被禁用；`Date` 冻结在 mock 世界的 now（2026-03-15T10:00Z），`Math.random` 有固定种子（为了缓存重放的确定性）；预算靠在每个循环体和函数体开头插入 `__tick()`，再加上同步部分的 vm timeout。（vm 的 timeout 配合 `microtaskMode: "afterEvaluate"`，在 microtask 里超时会让 Node 进程 abort，所以没有用这个组合。）

---

## 9. 复现

```sh
cd bench
node harness/cli.js status                  # 48/48 done
node harness/cli.js plan                    # 待跑 0 格，已花费 $0.1154
node harness/cli.js selfcheck               # 离线重放两次，48 deterministic
node harness/cli.js regrade                 # 离线重新判分，0 个新请求
node analysis/smoke.js [--episodes]         # 本报告的表格，加 --episodes 输出每条的代码和结果
```

`runs/` 不进仓库，所以以上命令要在跑过 smoke 的那份工作目录里执行。
