#!/usr/bin/env node
// 用 check-host.net 的香港探测点做「亚洲视角可达性」筛选。
//
// 为什么不是国内视角：check-host 没有中国大陆节点（55 个点里最近的是 hk1）。香港不在墙内，
// 测不出 GFW 拦截，但能筛掉「从亚洲根本连不上」的节点（只在欧美可达、或已被打死的）。
// 等有了墙内探测源，把输入换成同样的 JSON 结构即可，下游 verify.mjs 不用改。
//
// 用法：node scripts/hk-probe.mjs [--budget=200] [--gap=4000] [--resume]
//   --budget  本轮最多测多少 host:port
//   --gap     相邻两次请求的间隔 ms（check-host 限流较紧，3s 会偶发 limit_exceeded，4s 稳）
//   --resume  已有结果的跳过（配合定时任务分批覆盖全量）
//
// 产出：dist/hk-probe.json
//   { generatedAt, vantage: "hk1.check-host.net", total, ok, okRate, results: { "host:port": {ok, ms} } }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const 根 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(根, 'dist');
const 参数 = new Map(process.argv.slice(2).map((a) => { const [k, v = 'true'] = a.replace(/^--/, '').split('='); return [k, v]; }));

const 预算 = Number(参数.get('budget') || 200);
const 间隔 = Number(参数.get('gap') || 4000);
const 续跑 = 参数.has('resume');
const 最多年龄 = Number(参数.get('max-age-hours') || 48);
const 节点 = 参数.get('node') || 'hk1.node.check-host.net';
const 源 = process.env.SOURCE || path.join(DIST, 'clash-lite.yaml');
const 输出 = path.join(DIST, 'hk-probe.json');
const 睡眠 = (ms) => new Promise((r) => setTimeout(r, ms));
const 日志 = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---------- 目标任务 ----------
const doc = yaml.load(fs.readFileSync(源, 'utf8'));
const 唯一 = new Map();
for (const p of doc.proxies || []) {
  if (p && p.server && p.port) 唯一.set(`${p.server}:${p.port}`, { host: p.server, port: p.port });
}
let 历史 = {};
try { 历史 = JSON.parse(fs.readFileSync(输出, 'utf8')).results || {}; } catch { }

const 过期 = Date.now() - 最多年龄 * 3600e3;
let 目标 = [...唯一.keys()].filter((k) => {
  if (!续跑) return true;
  const 旧 = 历史[k];
  // 有结果且不算太旧就跳过
  return !旧 || (旧.at && Date.parse(旧.at) < 过期);
});
// 优先测「从没测过」的
目标.sort((a, b) => (历史[a] ? 1 : 0) - (历史[b] ? 1 : 0));
目标 = 目标.slice(0, 预算);
日志(`源 ${path.basename(源)}：${唯一.size} 个唯一 host:port，本轮测 ${目标.length} 个（间隔 ${间隔}ms）`);
if (!目标.length) { 日志('没有需要测的目标'); process.exit(0); }

// ---------- 发起 ----------
const 时间预算 = Number(参数.get('time-budget') || 900) * 1000;
const 开始 = Date.now();
const 待查 = new Map(); // request_id -> host:port
let 限流 = 0, 提前停 = false;
for (const hp of 目标) {
  if (Date.now() - 开始 > 时间预算 * 0.6) { 提前停 = true; 日志('接近时间预算，停止发起新请求'); break; }
  let 成功 = false;
  for (let 重试 = 0; 重试 < 3 && !成功; 重试++) {
    try {
      const r = await fetch(`https://check-host.net/check-tcp?host=${encodeURIComponent(hp)}&node=${encodeURIComponent(节点)}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'node-radar/hk-probe (+https://github.com/jingjiangze/node-radar)' },
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => ({}));
      if (j && j.request_id) { 待查.set(j.request_id, hp); 成功 = true; break; }
      if (j && j.error === 'limit_exceeded') {
        限流++;
        // 连续被限流就别硬顶了，保住已经发出去的
        if (限流 >= 6) { 提前停 = true; 日志('连续限流，停止发起新请求'); break; }
        await 睡眠(20000);
        continue;
      }
    } catch { }
    await 睡眠(3000);
  }
  if (提前停) break;
  if (!成功) 日志(`  发起失败: ${hp}`);
  await 睡眠(间隔);
}
日志(`已发起 ${待查.size} 个探测请求（限流 ${限流} 次${提前停 ? '，提前停止' : ''}）`);

// ---------- 取结果 ----------
await 睡眠(8000);
const 本轮 = {};
const 未决 = new Set(待查.keys());
for (let 轮 = 0; 轮 < 8 && 未决.size; 轮++) {
  for (const rid of [...未决]) {
    try {
      const r = await fetch(`https://check-host.net/check-result/${rid}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'node-radar/hk-probe' },
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => ({}));
      const 节点结果 = j[节点];
      if (!节点结果) continue;             // 还没出
      const hp = 待查.get(rid);
      const 首 = Array.isArray(节点结果) ? 节点结果[0] : null;
      const 项 = Array.isArray(首) ? 首[0] : null;
      if (!项) continue;
      if (typeof 项.time === 'number') 本轮[hp] = { ok: true, ms: Math.round(项.time * 1000), at: new Date().toISOString() };
      else 本轮[hp] = { ok: false, ms: null, at: new Date().toISOString(), error: String(项.error || 'unknown').slice(0, 40) };
      未决.delete(rid);
      // 每拿到一批就落盘，被超时/中断也不会丢进度
      if (Object.keys(本轮).length % 5 === 0) {
        const 暂存 = { ...历史, ...本轮 };
        fs.writeFileSync(输出, JSON.stringify({
          generatedAt: new Date().toISOString(), vantage: 节点, scope: path.basename(源),
          total: Object.keys(暂存).length,
          ok: Object.values(暂存).filter((x) => x.ok).length,
          results: 暂存,
        }, null, 0) + '\n');
      }
    } catch { }
    await 睡眠(600);
  }
  if (未决.size) await 睡眠(5000);
}

// ---------- 合并写出 ----------
const 合并 = { ...历史, ...本轮 };
const 条数 = Object.keys(合并).length;
const 可达 = Object.values(合并).filter((x) => x.ok).length;
const 报告 = {
  generatedAt: new Date().toISOString(),
  vantage: 节点,
  scope: path.basename(源),
  total: 条数,
  ok: 可达,
  okRate: Number(((可达 / Math.max(1, 条数)) * 100).toFixed(1)),
  thisRound: { probed: Object.keys(本轮).length, ok: Object.values(本轮).filter((x) => x.ok).length, pending: 未决.size },
  results: 合并,
};
fs.writeFileSync(输出, JSON.stringify(报告, null, 0) + '\n');
日志(`本轮完成 ${Object.keys(本轮).length} 个（可达 ${报告.thisRound.ok}），累计 ${条数} 条，可达率 ${报告.okRate}%`);
if (未决.size) 日志(`仍有 ${未决.size} 个未出结果，下轮 --resume 会补`);
