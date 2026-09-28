/**
 * 只读：打 dsh-connect 的渠道中心状态路由，把每行的签到/额度打印出来。
 * 用法：node scripts/connect-status.mjs [路由后缀] [方法]
 *   默认 GET /plugins/dsh-connect/status
 *   POST 单渠道：node scripts/connect-status.mjs /plugins/dsh-connect/checkin/qoder POST
 */
const route = process.argv[2] ?? "/plugins/dsh-connect/status";
const method = process.argv[3] ?? "GET";
const ORIGIN = "http://127.0.0.1:3080";
const BASE = process.env.DSH_BASE ?? "http://127.0.0.1:3088";

const res = await fetch(`${BASE}${route}`, { method, headers: { accept: "application/json", origin: ORIGIN } });
const text = await res.text();
console.log(`${method} ${route}  →  HTTP ${res.status}`);
let body;
try { body = JSON.parse(text); } catch { console.log(text.slice(0, 800)); process.exit(0); }

const rows = body.channels ?? body.rows ?? (Array.isArray(body) ? body : null);
if (rows) {
  for (const r of rows) {
    const ck = r.checkin ?? {};
    const cr = r.credits ?? {};
    console.log(
      `  ${String(r.id ?? r.kind).padEnd(12)} 签到=${String(ck.state ?? "?").padEnd(12)} 额度=${String(cr.label ?? "-").padEnd(18)} ${String(ck.note ?? "").slice(0, 50)}`,
    );
  }
  if (body.summary) console.log(`  汇总: ${JSON.stringify(body.summary)}`);
} else {
  console.log(JSON.stringify(body, null, 2).slice(0, 1200));
}
