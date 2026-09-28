#!/usr/bin/env node
/**
 * trae-rates-selftest.mjs —— Trae 倍率链路的自检（**在 dsh 容器内运行**）。
 *
 * 分两段：
 *
 *   ① 离线段（不联网、不需要凭据，随时可跑）
 *        · `parseRateRegistry` 对注册表文档的解析
 *          —— 基本取值 / 只有会员折扣时回退原价 / 活动价 / 跨 function 去重 /
 *             坏 JSON / 无 config_name / 与倍率无关的条目 / 数字串
 *        · `createCatalog` 的**两层叠加**：live 优先、快照兜底、失败保留上一次
 *
 *   ② 在线段（需要 /root/.dsh/connect-auth/trae.json）
 *        · 用真实凭据打一次注册表，报出覆盖了几个展示模型
 *        · 核对 header 契约：把 X-Ide-Version-Code 换成小值应当**静默降级**
 *          （200 但解析不出任何倍率）——这正是"倍率全空"的根因，值得固化
 *
 * 用法（宿主）：
 *   docker exec -w /root/.dsh/profiles/web dsh-harness \
 *     node /workspace/dsh4docker/scripts/trae-rates-selftest.mjs
 *
 * 可选参数：--offline 只跑离线段
 *
 * 脚本**绝不打印** token。
 */

import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

/**
 * 脚本放在 /workspace/dsh4docker/scripts，从这里往上找不到 profile 的 node_modules，
 * 所以按插件在容器内的真实路径导入 —— 插件内部的依赖会沿 vendor 目录往上解析。
 *
 * 注意：[dsh-connect 三合一之后] 路径不再是 `vendor/dsh-trae-connect/lib/index.js`，
 * 而是聚合插件下的 provider 子模块。
 */
const PLUGIN_ENTRY =
  process.env.TRAE_PLUGIN_ENTRY ?? '/root/.dsh/profiles/web/vendor/dsh-connect/lib/providers/trae/index.js';

const trae = await import(pathToFileURL(PLUGIN_ENTRY).href);
const { parseRateRegistry, createTraeRateClient, createCatalog, createCredentialStore, TRAE_FUNCTIONS } = trae;

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);

// ── 迷你断言框架（与 qoder-connect-selftest.mjs 同风格） ────────────────────
let pass = 0;
const fails = [];
function ok(label, extra) {
  pass += 1;
  console.log(`  ✓ ${label}${extra === undefined ? '' : `  (${extra})`}`);
}
function eq(label, actual, expected) {
  if (Object.is(actual, expected)) ok(label, String(actual));
  else {
    fails.push(label);
    console.log(`  ✗ ${label}  期望 ${JSON.stringify(expected)} 实得 ${JSON.stringify(actual)}`);
  }
}

/** 造一条 config_info_list 条目：display_contact_config 是字符串化的 JSON（与上游一致）。 */
function entry(configName, contact) {
  return { config_name: configName, display_contact_config: JSON.stringify(contact) };
}

// ── ① 离线段 ───────────────────────────────────────────────────────────────
console.log('\n── ① 离线段：注册表解析 ──');
{
  const doc = {
    function_configs: [
      {
        function: 'solo_work_lite',
        config_info_list: [
          entry('DeepSeek-V4-Pro', { consumption_rate: { enable: true, data: { rate: 0.72 } } }),
          // 只有会员折扣、没有 consumption_rate —— glm-5.3 的实际形状，必须回退原价
          entry('glm-5.3', { discount: { enable: true, data: { original_consumption_rate: 0.78, consumption_rate: 0.39 } } }),
          // 活动价（补贴）
          entry('Doubao-Seed-Code', {
            consumption_rate: { enable: true, data: { rate: 0.12 } },
            activity_discount: { enable: true, data: { current: { consumption_rate: 0.06 } } },
          }),
          // 数字串 —— 上游改形状的兜底
          entry('kimi-k3', { consumption_rate: { data: { rate: '1.83' } } }),
          // 与倍率无关的条目（只有 manual_usage）
          entry('title_generation', { cost: { enable: true, data: { manual_usage: 1 } } }),
          // 坏 JSON
          { config_name: 'broken', display_contact_config: '{not json' },
          // 没有 config_name
          { display_contact_config: JSON.stringify({ consumption_rate: { data: { rate: 1 } } }) },
        ],
      },
      {
        function: 'solo_coder',
        config_info_list: [
          // 同一个模型在另一个 function 下出现，取值一致 → 必须只留一条
          entry('DeepSeek-V4-Pro', { consumption_rate: { enable: true, data: { rate: 0.72 } } }),
        ],
      },
    ],
  };

  // 入表 4 个：DeepSeek-V4-Pro / glm-5.3 / Doubao-Seed-Code / kimi-k3。
  // title_generation（只有 manual_usage）、broken（坏 JSON）、无 config_name 的三条都要被丢掉；
  // DeepSeek-V4-Pro 在两个 function 下各出现一次，只算一条。
  const map = parseRateRegistry(doc);
  eq('解析出的模型数', map.size, 4);
  eq('基本倍率', map.get('DeepSeek-V4-Pro').rate, 0.72);
  eq('无 consumption_rate 时回退折扣原价', map.get('glm-5.3').rate, 0.78);
  eq('会员折扣价', map.get('glm-5.3').rateDiscount, 0.39);
  eq('活动价', map.get('Doubao-Seed-Code').rateActivity, 0.06);
  eq('数字串容忍', map.get('kimi-k3').rate, 1.83);
  eq('无关条目不进表', map.has('title_generation'), false);
  eq('坏 JSON 不进表', map.has('broken'), false);
  eq('跨 function 去重', map.get('DeepSeek-V4-Pro').rateDiscount, undefined);
}

console.log('\n── ① 离线段：catalog 两层叠加 ──');
{
  // 不指向任何真实文件 → 走兜底名单（无 rate）
  const catalog = createCatalog({ config: () => ({ modelCatalogFile: '/nonexistent/models.json' }) });
  eq('无快照时 source 是 fallback', catalog.source(), 'fallback');
  eq('初始 ratesSource', catalog.ratesSource(), 'none');
  eq('初始无倍率', catalog.current()[0].rate, undefined);

  catalog.setRates(new Map([['DeepSeek-V4-Flash-Official', { id: 'DeepSeek-V4-Flash-Official', rate: 0.16 }]]));
  eq('灌入 live 后 ratesSource', catalog.ratesSource(), 'live');
  const live = catalog.current().find((m) => m.id === 'DeepSeek-V4-Flash-Official');
  eq('live 倍率已合并进模型', live.rate, 0.16);
  eq('未覆盖的模型仍然没有倍率', catalog.current().find((m) => m.id === 'kimi-k3').rate, undefined);
  const coverage = catalog.rateCoverage();
  ok('覆盖统计', `${coverage.covered}/${coverage.total}`);

  // 全量替换语义：上游这次没给的模型不会留着上一次的值
  catalog.setRates(new Map());
  eq('全量替换：清空后不留旧值', catalog.current().find((m) => m.id === 'DeepSeek-V4-Flash-Official').rate, undefined);

  // 失败路径：保留上一次的值，只记错误
  catalog.setRates(new Map([['DeepSeek-V4-Flash-Official', { id: 'DeepSeek-V4-Flash-Official', rate: 0.16 }]]));
  catalog.markRatesFailed(new Error('boom'));
  eq('失败后倍率保留', catalog.current().find((m) => m.id === 'DeepSeek-V4-Flash-Official').rate, 0.16);
  eq('失败后记下错误', catalog.ratesError(), 'boom');
  ok('失败也推进时间戳（避免 30s 重试风暴）', String(catalog.ratesFetchedAt() > 0));

  // 换账号：清空基线，否则下一次刷新的"降级保护"会拿旧账号的覆盖数误判
  catalog.clearRates();
  eq('换账号后倍率清空', catalog.current().find((m) => m.id === 'DeepSeek-V4-Flash-Official').rate, undefined);
  eq('换账号后 ratesSource 归零', catalog.ratesSource(), 'none');
  eq('换账号后清掉旧错误', catalog.ratesError(), undefined);
}

// ── ② 在线段 ───────────────────────────────────────────────────────────────
if (has('--offline')) {
  console.log('\n（--offline：跳过在线段）');
} else {
  console.log('\n── ② 在线段：真实凭据打一次注册表 ──');
  const store = createCredentialStore({ config: () => ({}), logger: { warn: () => {} } });
  const credential = await store.resolve().catch((error) => {
    console.log(`  ! 读不到凭据，跳过在线段：${error.message}`);
    return undefined;
  });
  if (credential !== undefined) {
    ok('凭据可用', `user=${credential.userId || '?'} appVersionCode=${credential.appVersionCode ?? '(缺)'}`);

    const rateClient = createTraeRateClient({ logger: { info: () => {}, warn: () => {} } });
    const FUNCTIONS = [...TRAE_FUNCTIONS, 'assistant', 'builder'];
    const map = await rateClient.fetchRates(credential, FUNCTIONS);
    ok('注册表返回', `${map.size} 个模型的倍率`);

    const catalog = createCatalog({ config: () => ({}) });
    catalog.setRates(map);
    const coverage = catalog.rateCoverage();
    ok('覆盖展示清单', `${coverage.covered}/${coverage.total}`);
    if (coverage.covered < coverage.total) {
      console.log(`     未覆盖：${catalog.current().filter((m) => !map.has(m.id)).map((m) => m.id).join(', ')}`);
    }

    // header 契约：版本号换成小值会被**静默降级**，解析不出任何倍率但不报错
    try {
      await rateClient.fetchRates({ ...credential, appVersionCode: 1 }, FUNCTIONS);
      console.log('  ! 版本号降级实验：居然解析出了倍率 —— 上游行为已变，复核注释');
    } catch (error) {
      ok('版本号用小值会被静默降级（正是"倍率全空"的根因）', String(error.message).slice(0, 48));
    }

    // 顺带确认 catalog 读的是真实 models.json
    const snap = JSON.parse(readFileSync('/root/.dsh/trae/models.json', 'utf8'));
    console.log(`     快照 ${snap.models.length} 个模型，rateSource=${snap.rateSource ? '有（旧版离线导出）' : '无'}`);
  }
}

console.log(`\n${fails.length === 0 ? '全部通过' : `有 ${fails.length} 项失败`}：通过 ${pass} 项`);
if (fails.length > 0) {
  console.log(`失败项：${fails.join(' / ')}`);
  process.exit(1);
}
