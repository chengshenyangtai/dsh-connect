#!/usr/bin/env node
/**
 * wb-login.mjs —— 从宿主机驱动 WorkBuddy 的扫码登录（不需要桌面 App）。
 *
 * 走的是插件自己的回环路由（`<n>/login/start` → `<n>/login/poll`），
 * 授权码由腾讯下发，落盘由容器内的插件完成。本脚本只当"人手"：
 * 取链接、打印、轮询、报结果 —— **不碰任何令牌**（路由也不回传令牌）。
 *
 * 用法：
 *   node scripts/wb-login.mjs                 # variant 1（国内版）
 *   node scripts/wb-login.mjs -v 2 --open     # 国际版，并直接用默认浏览器打开
 *   node scripts/wb-login.mjs --wait 900      # 最多等 15 分钟（默认 600 秒）
 *
 * 退出码：0 已登录 / 1 被拒或失败 / 2 超时（过期）
 */
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 || args[i + 1] === undefined ? fallback : args[i + 1];
};
const variant = argOf('-v', argOf('--variant', '1'));
const base = argOf('--base', process.env.WB_BASE ?? 'http://127.0.0.1:3088').replace(/\/$/, '');
const waitSeconds = Number(argOf('--wait', '600'));
const shouldOpen = args.includes('--open');
const route = `${base}/plugins/dsh-workbuddy-connect/${variant}/login`;
const POLL_MS = 2000;

/** 收尾打印的字段白名单：路由不回传令牌，这里也不猜。 */
const summarize = (doc) =>
  ['status', 'uid', 'nickname', 'enterpriseId', 'domain', 'source', 'reason', 'error']
    .filter((key) => doc[key] !== undefined)
    .map((key) => `${key}=${doc[key]}`)
    .join('  ');

const json = async (url, init) => {
  const response = await fetch(url, init);
  const text = await response.text();
  try {
    return { status: response.status, doc: JSON.parse(text) };
  } catch {
    return { status: response.status, doc: { error: text.slice(0, 200) } };
  }
};

console.log(`→ ${route}/start`);
const started = await json(`${route}/start`, { method: 'POST' });
if (started.doc?.ok !== true) {
  console.error(`✗ 起不了登录：HTTP ${started.status} ${summarize(started.doc ?? {})}`);
  process.exit(1);
}
const { state, authUrl } = started.doc;
const expiresAt = Date.now() + (started.doc.expiresInMs ?? 900000);

console.log('\n用手机微信/QQ 扫码，或直接用浏览器打开下面这个链接（页面自带二维码）：\n');
console.log(`    ${authUrl}\n`);
if (shouldOpen) {
  const { spawn } = await import('node:child_process');
  spawn('open', [authUrl], { stdio: 'ignore', detached: true }).unref();
  console.log('（已尝试用默认浏览器打开）\n');
}
console.log(`轮询中，最多等 ${waitSeconds} 秒…`);

const deadline = Math.min(Date.now() + waitSeconds * 1000, expiresAt);
let last = '';
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  let polled;
  try {
    polled = await json(`${route}/poll?state=${encodeURIComponent(state)}`);
  } catch (error) {
    process.stdout.write(`\r  轮询异常，重试中：${String(error).slice(0, 60)}          `);
    continue;
  }
  const { status, doc } = polled;
  const line = `  ${status} ${summarize(doc)}`;
  /**
   * 只有 TTY 里才原地重绘：管道/日志里 `\r` 不会覆盖，反而把同一行刷成几十行。
   * 非 TTY 就只在状态**变化**时打印一行。
   */
  if (!process.stdout.isTTY) {
    if (line !== last) {
      console.log(line);
      last = line;
    }
  } else if (line !== last) {
    process.stdout.write(`\r${line.padEnd(78)}\n`);
    last = line;
  } else {
    process.stdout.write(`\r${line.padEnd(78)}`);
  }
  if (doc?.status === 'signed-in') {
    console.log('\n✓ 已登录并落盘（令牌只存在容器内，本脚本从未看到）');
    process.exit(0);
  }
  if (doc?.status === 'blocked' || doc?.status === 'failed' || status >= 500) {
    console.log('\n✗ 未能登录');
    process.exit(1);
  }
  if (doc?.status === 'expired' || doc?.status === 'unknown') {
    console.log('\n✗ 授权码已失效（或已被消费），请重新运行本脚本');
    process.exit(2);
  }
}
console.log('\n→ 超时：仍未授权。授权码 15 分钟有效，重新跑一次即可。');
process.exit(2);
