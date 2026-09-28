/**
 * Qoder CN 签到活动端点 —— **请求头对照实验**。
 *
 * 起因：`GET https://openapi.qoder.com.cn/sash/api/v1/me/campaigns` 用「裸 Bearer +
 * cosy-clienttype:5」拿到的永远是 `{showCampaign:false, claimable:false, campaigns:[]}`，
 * 但桌面 App 同时刻拿到的是 `{showCampaign:true, claimable:true, campaigns:[…100 credits…]}`。
 *
 * 差异来自**请求头**（App 的 main.log「活动状态请求发出」列出了它发的头）：
 *   Cosy-ClientType: 10           ← 旧实现写的是 5
 *   Cosy-Version:    0.4.1        ← = App 版本，旧实现不带
 *   Cosy-MachineOS / MachineHostname / MachineId / MachineToken / MachineCode / MachineType
 *
 * 本脚本**逐个叠加**这些头，看哪一项真正决定服务端返回活动 —— 只读，不领取。
 *
 * 用法：DSH_HOME=~/.dsh node scripts/qoder-campaign-headers-probe.mjs
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const ENDPOINT = "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns";

function readToken() {
  try {
    return JSON.parse(readFileSync(join(DSH_HOME, "qoder", "session.json"), "utf8")).token ?? null;
  } catch {
    return null;
  }
}
function readMachineId() {
  try {
    return readFileSync(join(DSH_HOME, "qoder", "machine-id"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

const token = readToken();
const machineId = readMachineId();
if (!token) {
  console.error(`✗ 读不到凭据（${join(DSH_HOME, "qoder", "session.json")}）`);
  process.exit(1);
}

const base = { accept: "application/json", authorization: `Bearer ${token}`, "user-agent": "Qoder" };

// 逐层叠加。每一步只比上一步多一组头，这样结论能归因到具体项。
const CASES = [
  ["A 现状（clienttype 5，无其它）", { ...base, "cosy-clienttype": "5" }],
  ["B A + ClientType:10", { ...base, "cosy-clienttype": "10" }],
  ["C B + Cosy-Version:0.4.1", { ...base, "cosy-clienttype": "10", "cosy-version": "0.4.1" }],
  ["D C + MachineId", { ...base, "cosy-clienttype": "10", "cosy-version": "0.4.1", "cosy-machineid": machineId ?? "" }],
  ["E D + MachineOS/Hostname", {
    ...base, "cosy-clienttype": "10", "cosy-version": "0.4.1",
    "cosy-machineid": machineId ?? "", "cosy-machineos": "darwin", "cosy-machinehostname": hostname(),
  }],
  ["F E + MachineType:5", {
    ...base, "cosy-clienttype": "10", "cosy-version": "0.4.1",
    "cosy-machineid": machineId ?? "", "cosy-machineos": "darwin", "cosy-machinehostname": hostname(),
    "cosy-machinetype": "5",
  }],
];

function summarize(payload) {
  const cs = Array.isArray(payload?.campaigns) ? payload.campaigns : [];
  const parts = cs.map((c) => {
    const amount = c?.benefit?.amount;
    return `${c?.campaignKey ?? "?"}:${c?.actionType ?? "?"}:${c?.claimStatus ?? "?"}${amount ? `:+${amount}` : ""}`;
  });
  return parts.length ? parts.join("  ") : "(campaigns 为空)";
}

console.log(`machine-id = ${machineId ?? "(缺)"}   hostname = ${hostname()}\n`);
for (const [label, headers] of CASES) {
  try {
    const res = await fetch(ENDPOINT, { headers });
    const body = await res.json().catch(() => null);
    console.log(`【${label}】`);
    console.log(`   HTTP ${res.status}  showCampaign=${body?.showCampaign}  claimable=${body?.claimable}`);
    console.log(`   campaignUrl=${body?.campaignUrl ? String(body.campaignUrl).slice(0, 70) : "(空)"}`);
    console.log(`   ${summarize(body)}\n`);
  } catch (error) {
    console.log(`【${label}】请求失败：${error?.message ?? error}\n`);
  }
}
