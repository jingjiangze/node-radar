#!/usr/bin/env node
// CI 测速：用 mihomo 真实跑一遍「经该节点下载」的速度（不是 ping，是实际吞吐）
// 做法：抽样 N 个节点 → 生成临时 mihomo 配置 → 启动内核 → 逐个切换并通过代理下载固定大小文件 → 记录 MB/s
// 注意：GitHub runner 在美国，测到的速度是「从美国出口」的真实吞吐；国内速度会不同，但相对排序有参考价值。

import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

const SAMPLE = Number(process.env.SAMPLE || 24);
const TEST_BYTES = Number(process.env.TEST_BYTES || 2000000);
const PORT = 7890;
const API = 'http://127.0.0.1:9090';
const MAX_TIME = 15;

const REGIONS = [
  ['香港', /香港|🇭🇰|\bHK\b|\bHKG\b|Hong ?Kong/i],
  ['台湾', /台湾|臺灣|🇹🇼|\bTW\b|Taiwan/i],
  ['日本', /日本|东京|東京|大阪|🇯🇵|\bJP\b|Japan/i],
  ['新加坡', /新加坡|狮城|🇸🇬|\bSG\b|Singapore/i],
  ['韩国', /韩国|韓國|首尔|首爾|🇰🇷|\bKR\b|Korea/i],
  ['美国', /美国|美國|洛杉矶|圣何塞|西雅图|纽约|芝加哥|达拉斯|硅谷|🇺🇸|\bUS\b|\bUSA\b|United ?States/i],
  ['英国', /英国|英國|伦敦|倫敦|🇬🇧|\bUK\b|\bGB\b|London/i],
  ['德国', /德国|德國|法兰克福|🇩🇪|\bDE\b|Germany/i],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 读上一版产出 ----------
let doc;
try {
  // 只测「连通性已过 + 国内可达」的那批（clash-lite），不是 4600 全量
  doc = yaml.load(fs.readFileSync(new URL('../dist/clash-lite.yaml', import.meta.url), 'utf8'));
} catch (e) {
  console.error('读不到 dist/clash-lite.yaml，跳过测速'); process.exit(0);
}
const all = (doc.proxies || []).filter((p) => p && p.server && p.port && p.type);
if (!all.length) { console.error('没有节点，跳过'); process.exit(0); }

// ---------- 分层抽样：每地区上限按 SAMPLE 均摊（写死 3 会让总数永远封顶在 地区数×3）----------
const 每地区上限 = Number(process.env.PER_REGION || Math.max(3, Math.ceil(SAMPLE / Math.max(1, REGIONS.length))));
const buckets = new Map();
for (const p of all) {
  let r = '其他';
  for (const [name, re] of REGIONS) if (re.test(p.name || '')) { r = name; break; }
  if (!buckets.has(r)) buckets.set(r, []);
  buckets.get(r).push(p);
}
const picked = [];
for (const [, list] of buckets) {
  // 打散后取前 3，避免总是测同一批
  const shuffled = list.slice().sort(() => Math.random() - 0.5);
  picked.push(...shuffled.slice(0, 每地区上限));
}
const sample = picked.slice(0, SAMPLE);
console.log(`候选 ${all.length}，抽样 ${sample.length}（${buckets.size} 个地区）`);

// ---------- 生成临时配置 ----------
const names = sample.map((p, i) => `${i}-${String(p.name || p.server).slice(0, 30)}`);
const proxies = sample.map((p, i) => ({ ...p, name: names[i] }));
const cfg = {
  'mixed-port': PORT,
  'allow-lan': false,
  mode: 'rule',
  'log-level': 'error',
  'external-controller': '127.0.0.1:9090',
  proxies,
  'proxy-groups': [{ name: 'TEST', type: 'select', proxies: names }],
  rules: ['MATCH,TEST'],
};
fs.writeFileSync('speedtest-config.yaml', yaml.dump(cfg, { lineWidth: 4096 }));

// ---------- 启动内核 ----------
const bin = process.env.MIHOMO_BIN || './mihomo';
const proc = spawn(bin, ['-d', '.', '-f', 'speedtest-config.yaml'], { stdio: ['ignore', 'pipe', 'pipe'] });
let coreLog = '';
proc.stdout.on('data', (d) => (coreLog += d.toString()));
proc.stderr.on('data', (d) => (coreLog += d.toString()));

const die = (msg) => { console.error(msg); try { proc.kill('SIGKILL'); } catch {} process.exit(0); };

// 等 API 就绪
let ready = false;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  try { const r = await fetch(`${API}/version`); if (r.ok) { ready = true; break; } } catch {}
}
if (!ready) die('内核没起来：' + coreLog.slice(-400));

// ---------- 逐个测速 ----------
const results = [];
for (let i = 0; i < names.length; i++) {
  const name = names[i];
  try {
    const sw = await fetch(`${API}/proxies/TEST`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!sw.ok) throw new Error('select ' + sw.status);
    await sleep(300);

    const out = execFileSync('curl', [
      '-s', '-o', '/dev/null', '-x', `http://127.0.0.1:${PORT}`,
      '--max-time', String(MAX_TIME),
      '-w', '%{http_code} %{speed_download} %{time_total}',
      `https://speed.cloudflare.com/__down?bytes=${TEST_BYTES}`,
    ], { encoding: 'utf8', timeout: (MAX_TIME + 5) * 1000 });

    const [code, bps, secs] = out.trim().split(/\s+/);
    const mbps = Number(bps) / 1048576;
    results.push({ name, node: names[i].replace(/^\d+-/, ''), server: sample[i]?.server, port: sample[i]?.port, ok: code === '200' && mbps > 0, http: code, mbps: Number(mbps.toFixed(3)), secs: Number(secs) });
    console.log(`${code} ${mbps.toFixed(2)} MB/s  ${names[i]}`);
  } catch (e) {
    results.push({ name, node: names[i].replace(/^\d+-/, ''), server: sample[i]?.server, port: sample[i]?.port, ok: false, error: String(e.message || e).slice(0, 60), mbps: 0 });
    console.log('FAIL ' + names[i]);
  }
}

try { proc.kill('SIGKILL'); } catch {}

// ---------- 输出 ----------
const okResults = results.filter((r) => r.ok).sort((a, b) => b.mbps - a.mbps);
const distDir = new URL('../dist/', import.meta.url);
const report = {
  testedAt: new Date().toISOString(),
  vantage: 'GitHub Actions (US)',
  sample: sample.length,
  ok: okResults.length,
  medianMbps: okResults.length ? Number(okResults[Math.floor(okResults.length / 2)].mbps.toFixed(3)) : 0,
  results,
};
fs.writeFileSync(new URL('speed.json', distDir), JSON.stringify(report, null, 2));

// 只发布「实测能跑」的前若干名，作为极速订阅
const TOP = Math.min(12, okResults.length);
if (TOP >= 5) {
  const topNames = new Set(okResults.slice(0, TOP).map((r) => r.node));
  const topProxies = sample.filter((p) => topNames.has(p.name)).map((p) => ({ ...p }));
  const topCfg = {
    'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'warning',
    'unified-delay': true, 'tcp-concurrent': true,
    proxies: topProxies,
    'proxy-groups': [{ name: '⚡ 极速', type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 600, tolerance: 50, proxies: topProxies.map((p) => p.name) }],
    rules: ['MATCH,⚡ 极速'],
  };
  fs.writeFileSync(new URL('speed-top.yaml', distDir), yaml.dump(topCfg, { lineWidth: 4096 }));
  console.log(`发布 speed-top.yaml：${topProxies.length} 个实测可用节点`);
} else {
  console.log(`实测可用只有 ${okResults.length} 个，不发布 speed-top.yaml`);
}
console.log(JSON.stringify({ ok: okResults.length, medianMbps: report.medianMbps }, null, 0));
