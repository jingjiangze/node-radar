#!/usr/bin/env node
// 中国大陆可达性探测（Globalping，jsDelivr 开源众包探测网络）
//
// 为什么用它：check-host.net 没有大陆节点（最近是 HK，测不出 GFW 拦截）；Globalping 匿名免 key、
// 实测有 60~70 个大陆探针（北京/上海/广州/深圳/成都…），支持 TCP + 指定端口。
// 匿名额度 250「探针·次」/小时，每个目标用 2 个大陆探针判（两个都收不到包才算不可达，减少误杀）。
//
// 用法：node scripts/cn-probe-gp.mjs [--budget=100] [--probes=2] [--resume] [--max-age-hours=48]
//   目标默认取自 dist/clash-lite.yaml（订阅实际用到的那批），去重 host:port
//
// 产出：dist/cn-probe.json
//   { generatedAt, vantage: "globalping-cn", total, ok, okRate, results: { "host:port": { ok, ms, at } } }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const 根 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(根, 'dist');
const 参数 = new Map(process.argv.slice(2).map((a) => { const [k, v = 'true'] = a.replace(/^--/, '').split('='); return [k, v]; }));

const 预算 = Number(参数.get('budget') || 100);
const 探针数 = Number(参数.get('probes') || 2);
const 并发 = Number(参数.get('concurrency') || 4);
const 续跑 = 参数.has('resume');
const 最多年龄 = Number(参数.get('max-age-hours') || 48);
const 源 = process.env.SOURCE || path.join(DIST, 'clash-lite.yaml');
const 输出 = path.join(DIST, 'cn-probe.json');
const 睡 = (ms) => new Promise((r) => setTimeout(r, ms));
const 日志 = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const UA = 'node-radar/cn-probe (+https://github.com/jingjiangze/node-radar)';

// ---------- 目标 ----------
const doc = yaml.load(fs.readFileSync(源, 'utf8'));
const 唯一 = new Map();
for (const p of doc.proxies || []) {
  if (p && p.server && p.port) 唯一.set(`${p.server}:${p.port}`, { host: p.server, port: Number(p.port) });
}
let 历史 = {};
try { 历史 = JSON.parse(fs.readFileSync(输出, 'utf8')).results || {}; } catch { }
const 过期 = Date.now() - 最多年龄 * 3600e3;
let 目标 = [...唯一.entries()].filter(([k]) => !续跑 || !历史[k] || Date.parse(历史[k].at || 0) < 过期);
目标.sort((a, b) => (历史[a[0]] ? 1 : 0) - (历史[b[0]] ? 1 : 0));
目标 = 目标.slice(0, 预算);
日志(`源 ${path.basename(源)}：${唯一.size} 个唯一 host:port，本轮测 ${目标.length} 个（每目标 ${探针数} 个大陆探针）`);
if (!目标.length) { 日志('没有需要探测的目标'); process.exit(0); }

// ---------- 探测 ----------
const 请求 = async (body) => {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('https://api.globalping.io/v1/measurements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, json: j, 余量: Number(r.headers.get('x-ratelimit-remaining') ?? -1) };
    } catch { await 睡(2000); }
  }
  return { status: 0, json: {}, 余量: -1 };
};

const 等结果 = async (id) => {
  for (let i = 0; i < 14; i++) {
    await 睡(2500);
    try {
      const r = await fetch(`https://api.globalping.io/v1/measurements/${id}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => ({}));
      if (j.status === 'finished') return j;
    } catch { }
  }
  return null;
};

const 本轮 = {};
let 余量 = -1;
let 停止 = false;

const 记账 = () => {
  const 合并 = { ...历史, ...本轮 };
  const 条数 = Object.keys(合并).length;
  const 可达 = Object.values(合并).filter((x) => x.ok).length;
  fs.writeFileSync(输出, JSON.stringify({
    generatedAt: new Date().toISOString(),
    vantage: 'globalping-cn',
    scope: path.basename(源),
    total: 条数,
    ok: 可达,
    okRate: Number(((可达 / Math.max(1, 条数)) * 100).toFixed(1)),
    results: 合并,
  }, null, 0) + '\n');
};

const 测一个 = async ([hp, t]) => {
  if (停止) return;
  if (余量 >= 0 && 余量 < 探针数) { 停止 = true; 日志('额度不足，停止发起新探测'); return; }
  const { status, json, 余量: rl } = await 请求({
    type: 'ping',
    target: t.host,
    locations: [{ country: 'CN', limit: 探针数 }],
    measurementOptions: { protocol: 'TCP', port: t.port },
  });
  if (rl >= 0) 余量 = rl;
  if (status === 429) { 停止 = true; 日志('额度用尽(429)，提前结束本轮'); return; }
  if (status !== 202 || !json.id) {
    日志(`  探测请求被拒(${status}) ${hp} ${JSON.stringify(json).slice(0, 80)}`);
    return;
  }
  const 结果 = await 等结果(json.id);
  if (!结果) { 日志(`  超时未出结果 ${hp}`); return; }
  const 探针 = 结果.results || [];
  const 收到 = 探针.filter((x) => (x.result?.stats?.rcv || 0) > 0);
  const 平均 = 收到.length ? Math.round(收到.reduce((a, x) => a + (x.result.stats.avg || 0), 0) / 收到.length) : null;
  本轮[hp] = {
    ok: 收到.length > 0,
    ms: 平均,
    at: new Date().toISOString(),
    probes: 探针.length,
    okProbes: 收到.length,
    cities: 探针.map((x) => x.probe?.city).filter(Boolean).slice(0, 4),
  };
  if (Object.keys(本轮).length % 10 === 0) { 记账(); 日志(`  进度 ${Object.keys(本轮).length}/${目标.length}（额度余 ${余量}）`); }
};

// 并发执行：额度是按「探针数」扣的，并发不会超支，只是把墙钟时间压下来
let 指针 = 0;
await Promise.all(Array.from({ length: Math.max(1, 并发) }, async () => {
  while (指针 < 目标.length && !停止) {
    const i = 指针++;
    await 测一个(目标[i]);
  }
}));

// ---------- 合并写盘 ----------
const 合并 = { ...历史, ...本轮 };
const 条数 = Object.keys(合并).length;
const 可达 = Object.values(合并).filter((x) => x.ok).length;
const 报告 = {
  generatedAt: new Date().toISOString(),
  vantage: 'globalping-cn',
  scope: path.basename(源),
  total: 条数,
  ok: 可达,
  okRate: Number(((可达 / Math.max(1, 条数)) * 100).toFixed(1)),
  thisRound: {
    probed: Object.keys(本轮).length,
    ok: Object.values(本轮).filter((x) => x.ok).length,
    unreachable: Object.values(本轮).filter((x) => !x.ok).length,
  },
  results: 合并,
};
fs.writeFileSync(输出, JSON.stringify(报告, null, 0) + '\n');
日志(`本轮 ${报告.thisRound.probed} 个（可达 ${报告.thisRound.ok}，国内不可达 ${报告.thisRound.unreachable}）；累计 ${条数} 条，可达率 ${报告.okRate}%`);
