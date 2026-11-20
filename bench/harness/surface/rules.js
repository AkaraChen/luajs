// Aligned surface rules (BENCH.md §2.3). One row per rule; the two languages
// differ only where the language itself forces it. Lua rows follow
// ARCHITECTURE.md §10.2, minus `parallel` (smoke decision: surface does not
// mention concurrency; fan-out is observed, not prompted).
//
// Any edit here changes what models see -> bump harness_version (common if a
// shared row changed, otherwise the language's own version).

export const RULES = [
  {
    id: "result",
    lua: "最后一个表达式就是结果（也可以写 return）。",
    js: "最后一个表达式就是结果（也可以写 return）。",
  },
  {
    id: "scope",
    lua: "local 不跨 run；写全局变量会报错，要跨 run 保存请用 state.x。",
    js: "变量不跨 run；给未声明的变量赋值会报错，要跨 run 保存请用 state.x。",
  },
  {
    id: "tools",
    lua: "tool 看起来是同步的：scope.name{...}，接收一个 table 参数；失败时抛出错误表 {kind, tool, message, data}，可用 pcall 接住。",
    js: "tool 是 async 函数：await scope.name({...})，接收一个对象参数；失败时抛出 Error（带 kind、tool、message、data 字段），可用 try/catch 接住。",
  },
  {
    id: "null",
    lua: "JSON 的 null 解码为 nil，字段可能缺失；遍历数组用 for i = 1, #t（ipairs 遇到空洞会停）。",
    js: "JSON 的 null 就是 null，字段也可能缺失（undefined）。",
  },
  {
    id: "strings",
    lua: "#s 是字节数，不是字符数；按字符截断用 utf8.offset / utf8.len。",
    js: "s.length 是 UTF-16 码元数，不是字符数；按字符截断用 Array.from(s)。",
  },
  {
    id: "syntax",
    lua: "下标从 1 开始；不等于是 ~=；字符串拼接是 ..。",
    js: "下标从 0 开始；比较用 === / !==。",
  },
  {
    id: "keys",
    lua: "JSON 对象的 key 保持字符串（数字 key 也是字符串）。",
    js: "JSON 对象的 key 是字符串（数字 key 也是字符串）。",
  },
  {
    id: "empty",
    lua: "空表发出去是 {}；要 [] 用 array()。",
    js: "[] 和 {} 原样发送。",
  },
  {
    id: "available",
    lua: "可用的只有：string（无 dump）、table、math（无 random）、utf8、pairs、ipairs、next、select、tostring、tonumber、type、pcall、xpcall、error、assert、print、array()、object()、state，以及下面列出的 tool。没有 io、os、require、load、debug、coroutine、元表函数。",
    js: "可用的只有：JS 内置对象（JSON、Math、Array、Object、Map、Set、Date 等）、console.log、state，以及下面列出的 tool。没有 require、import、fetch、setTimeout、process。",
  },
  {
    id: "no_rollback",
    lua: "失败的 run 不会撤销已经做过的 tool 调用。",
    js: "失败的 run 不会撤销已经做过的 tool 调用。",
  },
];

export const LANG_NAME = { js: "JavaScript", "lua-interim": "Lua 5.4" };
const ruleKey = (lang) => (lang === "js" ? "js" : "lua");

export function staticRules(lang) {
  return RULES.map((r, i) => `${i + 1}. ${r[ruleKey(lang)]}`).join("\n");
}

export function systemPrompt(lang) {
  return (
    `你可以调用 run 工具执行一段 ${LANG_NAME[lang]} 代码来完成用户的任务。` +
    `代码里能调用的 tool 和规则见 run 工具的说明。` +
    `任务要求的结果请作为代码最后一个表达式返回；拿到结果后，用简短的文字回答用户。`
  );
}

/**
 * Error hint table (ARCHITECTURE.md §9.5), applied by formatResult.
 * test(message, code, sourceLine) -> boolean
 */
export const HINTS = {
  lua: [
    { id: "neq", test: (m, c, l) => /!=/.test(l ?? "") || (/!=/.test(c) && /unexpected symbol near '!'|'!'/.test(m)), hint: "不等于用 ~=" },
    { id: "concat", test: (m, c, l) => /attempt to perform arithmetic on a string value/.test(m) || (/["']\s*\+|\+\s*["']/.test(l ?? "") && /arithmetic/.test(m)), hint: "字符串拼接用 .." },
    { id: "length", test: (m, c, l) => /\.length\b/.test(l ?? ""), hint: "长度用 #t（字符串的字符数用 utf8.len）" },
    { id: "global", test: (m) => /cannot assign global/.test(m), hint: "用 local 声明变量，或用 state.x 跨 run 保存" },
    { id: "nil_index", test: (m) => /attempt to index a nil value/.test(m), hint: "JSON null 会解码为 nil，字段可能缺失" },
    { id: "end", test: (m) => /'end' expected/.test(m), hint: "检查 if/for/function 是否都有配对的 end" },
    { id: "undefined_global", test: (m) => /undefined global|is not available in this sandbox/.test(m), hint: "只能使用规则里列出的库和 tool" },
    { id: "call_nil", test: (m) => /attempt to call a nil value \(field/.test(m), hint: "这个函数不存在；只能使用规则里列出的库和 tool" },
  ],
  js: [
    { id: "not_defined", test: (m) => /ReferenceError: \w+ is not defined/.test(m), hint: "只能使用规则里列出的 API；变量要先用 let/const 声明，跨 run 用 state.x" },
    { id: "null_prop", test: (m) => /Cannot read properties of (null|undefined)/.test(m), hint: "JSON 的 null 字段可能为 null，字段也可能缺失" },
    { id: "not_function", test: (m) => /is not a function/.test(m), hint: "这个函数不存在；tool 用 await scope.name({...}) 调用" },
    { id: "await", test: (m) => /await is only valid/.test(m), hint: "tool 是 async 函数，需要 await" },
  ],
};
