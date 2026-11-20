// Reference solutions computed directly against the mock world. Used only by
// `bench check-tasks` to (re)compute expected answers; grading reads the value
// frozen in each task file (BENCH.md §1.3), never this file.
import { buildWorld, ToolHost } from "./mock/index.js";

const DAY = 86400_000;

export const REFERENCE = {
  "c1-issue-assignee-01": (w) => w.issues["42"].assignee?.login ?? null,
  "c2-top-customers-01": (w) => {
    const now = new Date(w.now);
    const since = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
    const until = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const tot = new Map();
    for (const o of Object.values(w.orders)) {
      const t = Date.parse(o.created_at);
      if (t < since || t >= until || o.status === "cancelled") continue;
      tot.set(o.customer_id, (tot.get(o.customer_id) ?? 0) + o.amount);
    }
    const rows = [...tot].sort((a, b) => b[1] - a[1]);
    // guard: answer must be unambiguous (no ties around the cut, gap >= 1.00)
    for (let i = 0; i < 5; i++) if (rows[i][1] - rows[i + 1][1] < 1) throw new Error("ambiguous ranking");
    return rows.slice(0, 5).map(([customer_id, total]) => ({ customer_id, total: Math.round(total * 100) / 100 }));
  },
  "c3-refundable-fanout-01": (w) => {
    const now = Date.parse(w.now);
    return Object.values(w.orders)
      .filter((o) => o.customer_id === 10234)
      .filter((o) => ["paid", "shipped", "delivered"].includes(o.status) && now - Date.parse(o.created_at) <= 7 * DAY)
      .map((o) => o.id)
      .sort((a, b) => a - b);
  },
  "c5-truncate-zh-01": (w) => [...w.files["docs/公告.md"]].slice(0, 50).join(""),
  "c7-rate-limited-01": (w) => w.users.u_5.email,
  "c8-issue-title-01": (w) => w.issues["7"].title,
};

/** Sanity facts a task relies on (checked by `bench check-tasks`). */
export const PRECONDITIONS = {
  "c4-refund-expired-01": (w) => {
    const h = new ToolHost({ state: w, scopes: ["orders"] });
    const o = h.call("orders.get", { id: 1001 }).value;
    if (o.refundable !== false) throw new Error("order 1001 should not be refundable");
    if ((Date.parse(w.now) - Date.parse(o.created_at)) / DAY <= 7) throw new Error("order 1001 should be > 7 days old");
  },
  "c6-clear-labels-01": (w) => {
    if (!w.users.u_17.labels.length) throw new Error("u_17 must start with labels");
  },
  "c3-refundable-fanout-01": (w) => {
    const n = Object.values(w.orders).filter((o) => o.customer_id === 10234).length;
    if (n !== 20) throw new Error(`customer 10234 should have 20 orders, has ${n}`);
  },
};

export function computeReference(task) {
  const w = buildWorld(task.mock);
  PRECONDITIONS[task.id]?.(w);
  const f = REFERENCE[task.id];
  return f ? { has: true, value: f(w) } : { has: false };
}
