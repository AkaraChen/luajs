// Deterministic mock world "core-v1".
//
// One seed -> one JSON-serializable world state. No Math.random, no wall clock:
// every timestamp is an offset from BASE_NOW. Tools are synchronous, in-process
// functions over that state; the harness wraps them as async (JS) or
// synchronous-looking (Lua) calls.
//
// Bump MOCK_VERSION whenever anything in this file changes behaviour; the harness
// also fingerprints this file and refuses to run if content changed but the
// version did not (BENCH.md §4.7).

export const WORLD = "core-v1";
export const MOCK_VERSION = 1;
export const BASE_NOW = "2026-03-15T10:00:00Z";

const DAY = 86400_000;
const baseMs = Date.parse(BASE_NOW);
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

// ---------------------------------------------------------------- PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SURNAMES = ["王", "李", "张", "刘", "陈", "杨", "黄", "赵", "周", "吴", "徐", "孙"];
const GIVEN = ["伟", "芳", "娜", "敏", "静", "磊", "洋", "艳", "勇", "杰", "婷", "强", "雪", "晨"];
const LATIN = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi", "ivan", "judy"];
const EMOJI = ["🐱", "🌟", "🍀", "🚀", ""];
const USER_LABELS = ["vip", "beta", "churn-risk", "wholesale", "internal"];
const ISSUE_LABELS = ["bug", "feature", "docs", "p1", "p2", "stale", "question"];
const TITLE_EN = [
  "Crash when exporting CSV",
  "Add dark mode toggle",
  "Login page loads slowly",
  "Typo in onboarding email",
  "Webhook retries forever",
  "Support SSO with Okta",
  "Search ignores accents",
  "Pagination off by one",
];
const TITLE_ZH = [
  "导出报表时中文乱码",
  "订单页面加载缓慢",
  "退款按钮点击无反应",
  "希望支持批量修改标签",
  "移动端图片显示不全",
  "通知邮件重复发送",
];
const PRODUCTS = [
  { sku: "SKU-100", name: "机械键盘", price: 399.0 },
  { sku: "SKU-101", name: "无线鼠标", price: 129.9 },
  { sku: "SKU-102", name: "显示器支架", price: 219.5 },
  { sku: "SKU-103", name: "USB-C 扩展坞", price: 349.99 },
  { sku: "SKU-104", name: "降噪耳机", price: 899.0 },
  { sku: "SKU-105", name: "笔记本电脑包", price: 159.8 },
  { sku: "SKU-106", name: "移动硬盘 2TB", price: 559.25 },
];

// Fixed Chinese announcement used by text-processing tasks (no randomness).
const NOTICE_ZH =
  "各位同事：为进一步提升客户服务质量，公司决定自四月一日起调整售后退款流程，所有退款申请须在下单后七日内提交，并由客服主管复核后方可执行。" +
  "\n\n" +
  "具体安排如下：一、客服人员在受理申请时应核对订单状态与下单时间；二、超过七日的申请一律转交主管处理，不得自行退款；三、每周五汇总本周退款情况并发送至财务部门。" +
  "\n\n" +
  "如有疑问，请联系运营部。感谢大家的配合！";

// VIP customer with a block of recent orders (used by fan-out tasks).
export const VIP_CUSTOMER = 10234;
const VIP_ORDER_FIRST = 1101;
const VIP_ORDER_COUNT = 20;

/** Generate the initial world state from a seed. */
export function generateWorld(seed) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

  // users -------------------------------------------------------------
  const users = {};
  for (let i = 1; i <= 40; i++) {
    const zh = rnd() < 0.6;
    const name = zh ? pick(SURNAMES) + pick(GIVEN) + (rnd() < 0.5 ? pick(GIVEN) : "") : pick(LATIN);
    const u = {
      id: `u_${i}`,
      name: name + pick(EMOJI),
      email: `${zh ? "user" + i : name + i}@example.com`,
      created_at: iso(baseMs - int(30, 900) * DAY - int(0, 86399) * 1000),
      labels: USER_LABELS.filter(() => rnd() < 0.2),
    };
    const ph = rnd();
    if (ph < 0.6) u.phone = `+86 13${int(0, 9)}${String(int(0, 99999999)).padStart(8, "0")}`;
    else if (ph < 0.8) u.phone = null; // present but null
    // else: field missing entirely
    users[u.id] = u;
  }

  // issues ------------------------------------------------------------
  const issues = {};
  for (let id = 1; id <= 80; id++) {
    const created = baseMs - int(1, 120) * DAY - int(0, 86399) * 1000;
    const updated = Math.min(baseMs - 3600_000, created + int(0, 60) * DAY);
    const assigneeUser = rnd() < 0.7 ? users[`u_${int(1, 40)}`] : null;
    issues[String(id)] = {
      id,
      repo: rnd() < 0.7 ? "acme/shop" : "acme/infra",
      title: rnd() < 0.35 ? pick(TITLE_ZH) : pick(TITLE_EN),
      body: rnd() < 0.5 ? "复现步骤见附件。" : "Steps to reproduce are attached.",
      state: rnd() < 0.65 ? "open" : "closed",
      labels: ISSUE_LABELS.filter(() => rnd() < 0.18),
      assignee: assigneeUser ? { login: assigneeUser.id, name: assigneeUser.name } : null,
      comments: int(0, 12),
      created_at: iso(created),
      updated_at: iso(updated),
    };
  }

  // orders ------------------------------------------------------------
  const orders = {};
  const STATUSES = ["paid", "shipped", "delivered", "delivered", "cancelled"];
  for (let id = 1001; id <= 1240; id++) {
    const isVip = id >= VIP_ORDER_FIRST && id < VIP_ORDER_FIRST + VIP_ORDER_COUNT;
    let customer = 10201 + int(0, 39);
    if (customer === VIP_CUSTOMER && !isVip) customer = 10200; // VIP orders only come from the fixture block
    const created = isVip
      ? baseMs - int(0, 19) * DAY - int(0, 86399) * 1000
      : baseMs - int(0, 75) * DAY - int(0, 86399) * 1000;
    const items = [];
    const n = int(1, 3);
    for (let k = 0; k < n; k++) {
      const p = pick(PRODUCTS);
      items.push({ sku: p.sku, name: p.name, qty: int(1, 3), price: p.price });
    }
    const amount = Math.round(items.reduce((s, it) => s + it.qty * it.price, 0) * 100) / 100;
    orders[String(id)] = {
      id,
      customer_id: isVip ? VIP_CUSTOMER : customer,
      amount,
      currency: "CNY",
      status: pick(STATUSES),
      created_at: iso(created),
      items,
    };
  }

  // files -------------------------------------------------------------
  const files = {
    "docs/公告.md": NOTICE_ZH,
    "docs/readme.txt": "Internal docs. See 公告.md for the latest policy.\n",
    "data/notes.txt": "﻿备忘：周五下午三点开会。\n",
  };

  return { world: WORLD, seed, now: BASE_NOW, users, issues, orders, files };
}

// ---------------------------------------------------------------- schemas
const S = {
  int: { type: "integer" },
  str: { type: "string" },
  strArr: { type: "array", items: { type: "string" } },
};
const assigneeSchema = {
  anyOf: [{ type: "object", properties: { login: S.str, name: S.str }, required: ["login", "name"] }, { type: "null" }],
};
const issueSchema = {
  type: "object",
  properties: {
    id: S.int,
    repo: S.str,
    title: S.str,
    body: S.str,
    state: { enum: ["open", "closed"] },
    labels: S.strArr,
    assignee: assigneeSchema,
    comments: S.int,
    created_at: S.str,
    updated_at: S.str,
  },
};
const orderSummarySchema = {
  type: "object",
  properties: {
    id: S.int,
    customer_id: S.int,
    amount: { type: "number" },
    status: { enum: ["paid", "shipped", "delivered", "cancelled", "refunded"] },
    created_at: S.str,
  },
};
const orderSchema = {
  type: "object",
  properties: {
    ...orderSummarySchema.properties,
    currency: S.str,
    refundable: { type: "boolean" },
    items: {
      type: "array",
      items: { type: "object", properties: { sku: S.str, name: S.str, qty: S.int, price: { type: "number" } } },
    },
  },
};
const userSchema = {
  type: "object",
  properties: {
    id: S.str,
    name: S.str,
    email: S.str,
    phone: { type: ["string", "null"] },
    created_at: S.str,
    labels: S.strArr,
  },
  required: ["id", "name", "email", "created_at", "labels"],
};

const obj = (properties, required = []) => ({ type: "object", properties, required });

const REFUND_WINDOW_DAYS = 7;
const isRefundable = (o, nowMs) =>
  ["paid", "shipped", "delivered"].includes(o.status) && nowMs - Date.parse(o.created_at) <= REFUND_WINDOW_DAYS * DAY;

function fail(message, data) {
  const e = new Error(message);
  e.toolError = { kind: "tool_failed", message, ...(data !== undefined ? { data } : {}) };
  return e;
}
const notFound = (what, id) => fail(`${what} ${id} not found`, { code: "not_found" });
const summary = (o) => ({ id: o.id, customer_id: o.customer_id, amount: o.amount, status: o.status, created_at: o.created_at });

/** Tool table: name -> { description, input, output, readonly, impl(state, args) }. */
export const TOOLS = {
  "time.now": {
    description: "当前时间（UTC，ISO 8601）",
    input: obj({}),
    output: obj({ now: S.str }),
    readonly: true,
    impl: (st) => ({ now: st.now }),
  },
  "issues.get": {
    description: "按 id 获取 issue",
    input: obj({ id: S.int }, ["id"]),
    output: issueSchema,
    readonly: true,
    impl: (st, a) => st.issues[String(a.id)] ?? (() => { throw notFound("issue", a.id); })(),
  },
  "issues.list": {
    description: "列出 issue，每页 20 条；next_page 为 null 表示没有下一页",
    input: obj({ repo: S.str, state: { enum: ["open", "closed"] }, page: S.int }, ["repo"]),
    output: obj({ items: { type: "array", items: issueSchema }, next_page: { type: ["integer", "null"] } }),
    readonly: true,
    impl: (st, a) => {
      const all = Object.values(st.issues)
        .filter((i) => i.repo === a.repo && (!a.state || i.state === a.state))
        .sort((x, y) => x.id - y.id);
      const page = a.page ?? 1;
      const items = all.slice((page - 1) * 20, page * 20);
      return { items, next_page: page * 20 < all.length ? page + 1 : null };
    },
  },
  "issues.comment": {
    description: "给 issue 添加评论",
    input: obj({ id: S.int, body: S.str }, ["id", "body"]),
    output: obj({ id: S.int, comments: S.int }),
    impl: (st, a) => {
      const i = st.issues[String(a.id)];
      if (!i) throw notFound("issue", a.id);
      i.comments += 1;
      return { id: i.id, comments: i.comments };
    },
  },
  "issues.label": {
    description: "把 issue 的标签整体替换为 labels",
    input: obj({ id: S.int, labels: S.strArr }, ["id", "labels"]),
    output: obj({ id: S.int, labels: S.strArr }),
    impl: (st, a) => {
      const i = st.issues[String(a.id)];
      if (!i) throw notFound("issue", a.id);
      i.labels = [...a.labels];
      return { id: i.id, labels: i.labels };
    },
  },
  "orders.search": {
    description: "搜索订单（摘要）。since/before 为 ISO 时间：created_at >= since 且 < before；结果按 id 升序",
    input: obj({ customer_id: S.int, since: S.str, before: S.str, status: S.str }),
    output: { type: "array", items: orderSummarySchema },
    readonly: true,
    impl: (st, a) => {
      const since = a.since ? Date.parse(a.since) : -Infinity;
      const until = a.before ? Date.parse(a.before) : Infinity;
      if (Number.isNaN(since) || Number.isNaN(until)) throw fail("since/before must be ISO 8601 timestamps", { code: "invalid_args" });
      return Object.values(st.orders)
        .filter((o) => (a.customer_id === undefined || o.customer_id === a.customer_id) && (!a.status || o.status === a.status))
        .filter((o) => {
          const t = Date.parse(o.created_at);
          return t >= since && t < until;
        })
        .sort((x, y) => x.id - y.id)
        .map(summary);
    },
  },
  "orders.get": {
    description: "按 id 获取订单详情；refundable 表示当前是否满足退款条件",
    input: obj({ id: S.int }, ["id"]),
    output: orderSchema,
    readonly: true,
    impl: (st, a) => {
      const o = st.orders[String(a.id)];
      if (!o) throw notFound("order", a.id);
      return { ...o, refundable: isRefundable(o, Date.parse(st.now)) };
    },
  },
  "orders.refund": {
    description: "对订单执行退款（管理员接口，不会替你检查退款政策）",
    input: obj({ id: S.int, reason: S.str }, ["id", "reason"]),
    output: obj({ id: S.int, status: S.str }),
    impl: (st, a) => {
      const o = st.orders[String(a.id)];
      if (!o) throw notFound("order", a.id);
      if (o.status === "refunded") throw fail(`order ${a.id} already refunded`, { code: "conflict" });
      o.status = "refunded";
      o.refund_reason = a.reason;
      return { id: o.id, status: o.status };
    },
  },
  "users.get": {
    description: "按 id 获取用户；phone 可能为 null 或缺失",
    input: obj({ id: S.str }, ["id"]),
    output: userSchema,
    readonly: true,
    impl: (st, a) => st.users[a.id] ?? (() => { throw notFound("user", a.id); })(),
  },
  "users.find": {
    description: "按邮箱查找用户，找不到返回 null",
    input: obj({ email: S.str }, ["email"]),
    output: { anyOf: [userSchema, { type: "null" }] },
    readonly: true,
    impl: (st, a) => Object.values(st.users).find((u) => u.email === a.email) ?? null,
  },
  "users.set_labels": {
    description: "把用户的标签整体替换为 labels",
    input: obj({ id: S.str, labels: S.strArr }, ["id", "labels"]),
    output: obj({ id: S.str, labels: S.strArr }),
    impl: (st, a) => {
      const u = st.users[a.id];
      if (!u) throw notFound("user", a.id);
      u.labels = [...a.labels];
      return { id: u.id, labels: u.labels };
    },
  },
  "fs.list": {
    description: "列出目录下的文件路径",
    input: obj({ dir: S.str }, ["dir"]),
    output: S.strArr,
    readonly: true,
    impl: (st, a) => {
      const pre = a.dir.replace(/\/?$/, "/");
      return Object.keys(st.files).filter((p) => p.startsWith(pre)).sort();
    },
  },
  "fs.read": {
    description: "读取文本文件（UTF-8）",
    input: obj({ path: S.str }, ["path"]),
    output: obj({ path: S.str, content: S.str }),
    readonly: true,
    impl: (st, a) => {
      if (!(a.path in st.files)) throw fail(`file ${a.path} not found`, { code: "not_found" });
      return { path: a.path, content: st.files[a.path] };
    },
  },
  "fs.write": {
    description: "写入文本文件（覆盖）",
    input: obj({ path: S.str, content: S.str }, ["path", "content"]),
    output: obj({ path: S.str, bytes: S.int }),
    impl: (st, a) => {
      st.files[a.path] = a.content;
      return { path: a.path, bytes: Buffer.byteLength(a.content, "utf8") };
    },
  },
};

// ---------------------------------------------------------------- validation
function typeOk(t, v) {
  switch (t) {
    case "integer": return Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    case "array": return Array.isArray(v);
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    default: return true;
  }
}
const describe = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/** Minimal JSON Schema check for tool inputs. Returns an error string or null. */
export function validate(schema, v, path = "args") {
  if (!schema) return null;
  if (schema.anyOf) return schema.anyOf.some((s) => !validate(s, v, path)) ? null : `${path}: unexpected ${describe(v)}`;
  if (schema.enum && !schema.enum.includes(v)) return `${path}: must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(", ")}`;
  if (schema.type) {
    const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!ts.some((t) => typeOk(t, v))) return `${path}: expected ${ts.join("|")}, got ${describe(v)}`;
  }
  if (Array.isArray(v) && schema.items) {
    for (let i = 0; i < v.length; i++) {
      const e = validate(schema.items, v[i], `${path}[${i}]`);
      if (e) return e;
    }
  }
  if (typeOk("object", v) && schema.properties) {
    for (const r of schema.required ?? []) if (v[r] === undefined) return `${path}.${r}: required`;
    for (const [k, x] of Object.entries(v)) {
      if (!(k in schema.properties)) return `${path}.${k}: unknown field`;
      const e = validate(schema.properties[k], x, `${path}.${k}`);
      if (e) return e;
    }
  }
  return null;
}

// ---------------------------------------------------------------- tool host
/**
 * Per-episode ToolHost: owns the mutable world state, applies faults (the
 * Authorizer lives here too), and records every call as an effect. Shared by
 * the JS and Lua runtimes so grading is identical.
 */
export const MAX_CALLS_PER_RUN = 200;

export class ToolHost {
  constructor({ state, scopes, faults = [] }) {
    this.state = state;
    this.scopes = scopes;
    this.faults = faults.map((f) => ({ ...f, hits: 0 }));
    this.effects = [];
    this.runIndex = 0;
    this.callsThisRun = 0;
  }

  /** Called by the runtime at the start of every run. */
  beginRun(index) {
    this.runIndex = index;
    this.callsThisRun = 0;
  }

  tools() {
    return Object.keys(TOOLS).filter((n) => this.scopes.includes(n.split(".")[0]));
  }

  /** Synchronous call. Returns {ok:true,value} | {ok:false,error:{kind,tool,message,data?}}. */
  call(name, args, line) {
    // Budget: a run may make at most MAX_CALLS_PER_RUN tool calls; later calls
    // are not executed or recorded and end the run with status "budget".
    if (++this.callsThisRun > MAX_CALLS_PER_RUN)
      return { ok: false, error: { kind: "budget", tool: name, message: `budget exceeded (more than ${MAX_CALLS_PER_RUN} tool calls in one run)` } };
    const effect = { tool: name, args, status: "ok", line: line ?? null, run: this.runIndex };
    this.effects.push(effect);
    const t = TOOLS[name];
    if (!t || !this.tools().includes(name)) {
      effect.status = "failed";
      return { ok: false, error: { kind: "tool_failed", tool: name, message: `unknown tool ${name}` } };
    }
    const verr = validate(t.input, args);
    if (verr) {
      effect.status = "failed";
      return { ok: false, error: { kind: "tool_failed", tool: name, message: `invalid arguments: ${verr}`, data: { code: "invalid_args" } } };
    }
    for (const f of this.faults) {
      if (f.tool !== name) continue;
      if (f.match && !Object.entries(f.match).every(([k, v]) => JSON.stringify(args[k]) === JSON.stringify(v))) continue;
      if (f.times !== undefined && f.hits >= f.times) continue;
      f.hits++;
      const kind = f.error?.kind ?? "tool_failed";
      effect.status = kind === "denied" ? "denied" : "failed";
      return { ok: false, error: { kind, tool: name, message: f.error?.message ?? "fault", ...(f.error?.data ? { data: f.error.data } : {}) } };
    }
    try {
      const value = t.impl(this.state, args);
      return { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) };
    } catch (e) {
      effect.status = "failed";
      const te = e.toolError ?? { kind: "tool_failed", message: String(e.message ?? e) };
      return { ok: false, error: { ...te, tool: name } };
    }
  }
}
