/**
 * Qoder CN OpenAPI 平面 —— **`Cosy-ClientType` 5 vs 10 的逐端点对照**。
 *
 * 背景：App 主包里 `const Mh = Object.freeze({clientType: 10, businessProduct:"app",
 * sessionType:"app"})`，且 `YR(t)`（额度、dataPolicy、partnerPlan、remoteControl、
 * 活动全部用它）就发 `Cosy-ClientType: String(Mh.clientType)` = **10**。
 * 而 dsh-connect 的 qoder provider 写的是 `COSY_CLIENT_TYPE = "5"`。
 *
 * 已知后果：签到活动端点**按客户端类型门控** —— 用 5 永远返回
 * `{showCampaign:false, claimable:false, campaigns:[]}`（看起来像"账号没有活动"，
 * 极具误导性）；用 10 才返回真实活动。
 *
 * 本脚本回答另一个问题：**其余端点改成 10 会不会有副作用**（额度形状是否变化等）。
 * 全只读。用法：DSH_HOME=~/.dsh node scripts/qoder-openapi-clienttype-compare.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const OUTDIR = process.argv[2] ?? ".upgrade-0.1.7-rc.2/work";

const ENDPOINTS = [
  ["额度", "/sash/api/v2/me/usage"],
  ["签到活动", "/sash/api/v1/me/campaigns"],
  ["成就", "/sash/api/v1/me/achievements"],
  ["积分汇总", "/sash/api/v1/ai-conversations/credits-summary"],
  ["积分热力", "/sash/api/v1/ai-conversations/credits-heatmap?days=30&scope=app"],
  ["活动限额", "/sash/api/v1/me/campaigns/client_launch_26/limited-number"],
];

const token = JSON.parse(readFileSync(join(DSH_HOME, "qoder", "session.json"), "utf8")).token;
mkdirSync(OUTDIR, { recursive: true });

const results = {};
for (const [label, path] of ENDPOINTS) {
  results[label] = {};
  for (const clientType of ["5", "10"]) {
    const res = await fetch(`https://openapi.qoder.com.cn${path}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "cosy-clienttype": clientType,
        "user-agent": "Qoder",
      },
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 200); }
    results[label][clientType] = { status: res.status, body: parsed };
  }
}

for (const [label, path] of ENDPOINTS) {
  const a = results[label]["5"];
  const b = results[label]["10"];
  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log(`\n════ ${label}  (${path}) ════`);
  console.log(`   HTTP5=${a.status}  HTTP10=${b.status}   ${same ? "✅ 两档完全一致" : "⚠️ 两档不同"}`);
  if (!same) {
    console.log(`   clientType=5  → ${JSON.stringify(a.body).slice(0, 420)}`);
    console.log(`   clientType=10 → ${JSON.stringify(b.body).slice(0, 420)}`);
  } else {
    console.log(`   两者 → ${JSON.stringify(b.body).slice(0, 260)}`);
  }
}

writeFileSync(join(OUTDIR, "openapi-clienttype-compare.json"), JSON.stringify(results, null, 2));
console.log(`\n完整对照已写出：${join(OUTDIR, "openapi-clienttype-compare.json")}`);
