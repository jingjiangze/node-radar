#!/usr/bin/env node
// 真机验证层：TCP 可达 ≠ 能当代理用。这里用 mihomo 真正把流量打出去，只留跑得通的。
//
// 产出：
//   dist/verify.json          本轮报告（通过率、各渠道/地区统计、失败原因分布）
//   dist/node-health.json     跨运行健康台账（name → ok/fail/consecFail/ms/at）
//   dist/clash-verified.yaml  只含「真跑通且没有连续失败」的节点，地区均衡，供订阅内联
//
// 预算与抽样：每轮只测 BUDGET 个（默认 160），优先测「没测过」和「超过 STALE_HOURS 没测过」的，
// 按地区分层抽样，保证各地区都能轮到；全量 4000 个靠多轮轮转覆盖。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const 根 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(根, 'dist');
const 源文件 = process.env.SOURCE || path.join(DIST, 'clash.yaml');
const 健康文件 = path.join(DIST, 'node-health.json');
const 产物 = path.join(DIST, 'clash-verified.yaml');
const 报告文件 = path.join(DIST, 'verify.json');

const 预算 = Number(process.env.BUDGET || 160);
const 每地区 = Number(process.env.PER_REGION || 20);
const 超时ms = Number(process.env.PROBE_TIMEOUT || 6000);
const 陈旧小时 = Number(process.env.STALE_HOURS || 12);
const 最大失败 = Number(process.env.MAX_CONSEC_FAIL || 2);
const 产出上限 = Number(process.env.VERIFIED_MAX || 400);
const 产出每地区 = Number(process.env.VERIFIED_PER_REGION || 40);
const BIN = process.env.MIHOMO_BIN || 'mihomo';
const 端口 = 7892;
const API = 'http://127.0.0.1:9092';
const 测试URL = 'https://www.gstatic.com/generate_204';

const 睡 = (ms) => new Promise((r) => setTimeout(r, ms));
const 日志 = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const 地区判定 = (n) => {
  if (/香港|^HK[ -]|\bHKG\b|Hong ?Kong|🇭🇰/i.test(n)) return '香港';
  if (/台湾|臺灣|^TW[ -]|Taiwan|TWN|🇹🇼/i.test(n)) return '台湾';
  if (/日本|东京|東京|大阪|^JP[ -]|Japan|🇯🇵/i.test(n)) return '日本';
  if (/新加坡|狮城|^SG[ -]|Singapore|🇸🇬/i.test(n)) return '新加坡';
  if (/韩国|韓國|首尔|首爾|^KR[ -]|Korea|🇰🇷/i.test(n)) return '韩国';
  if (/美国|美國|洛杉矶|圣何塞|西雅图|纽约|芝加哥|达拉斯|硅谷|^US[ -]|\bUSA\b|United ?States|🇺🇸/i.test(n)) return '美国';
  if (/英国|英國|伦敦|倫敦|^UK[ -]|^GB[ -]|London|🇬🇧/i.test(n)) return '英国';
  if (/德国|德國|法兰克福|^DE[ -]|Germany|🇩🇪/i.test(n)) return '德国';
  return '其他';
};

const 读JSON = (f, 兜底) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return 兜底; } };

// ---------- 载入节点 ----------
const doc = yaml.load(fs.readFileSync(源文件, 'utf8'));
const 全部 = (doc.proxies || []).filter((p) => p && p.name && p.server && p.port && p.type);
if (!全部.length) { console.error('源文件里没有节点，退出'); process.exit(0); }
日志(`源 ${path.basename(源文件)}：${全部.length} 个节点`);

const 健康 = 读JSON(健康文件, {});
const 现在 = Date.now();
const 该测 = (n) => {
  const h = 健康[n];
  if (!h) return true;
  if ((h.consecFail || 0) >= 最大失败) return false;      // 已经判死的先不测，省预算
  return 现在 - Date.parse(h.at || 0) > 陈旧小时 * 3600e3;
};

// 分层抽样：先给「从没测过」的，再给「过期」的；每地区上限，总量上限
const 分桶 = new Map();
for (const p of 全部) {
  const r = 地区判定(p.name);
  if (!分桶.has(r)) 分桶.set(r, []);
  分桶.get(r).push(p);
}
for (const [, list] of 分桶) list.sort(() => Math.random() - 0.5);
const 样本 = [];
let 轮 = 0;
while (样本.length < 预算) {
  let 加了 = false;
  for (const [, list] of 分桶) {
    if (样本.length >= 预算) break;
    const 候选 = list[轮];
    if (!候选) continue;
    if (!该测(候选.name)) continue;
    样本.push(候选); 加了 = true;
    if (样本.filter((x) => 地区判定(x.name) === 地区判定(候选.name)).length >= 每地区) list.length = 0;
  }
  if (!加了) break;
  轮++;
}
if (!样本.length) { 日志('本轮没有需要测试的节点'); }
日志(`本轮抽样 ${样本.length} 个（预算 ${预算}，每地区上限 ${每地区}）`);

// ---------- 起内核 ----------
const 目录 = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
const 名 = 样本.map((p, i) => `${i}|${p.name}`.slice(0, 60));
const 配置 = {
  'mixed-port': 端口, 'allow-lan': false, mode: 'rule', 'log-level': 'silent',
  'external-controller': API.replace('http://', ''),
  proxies: 样本.map((p, i) => ({ ...p, name: 名[i] })),
  'proxy-groups': [{ name: 'T', type: 'select', proxies: 名 }],
  rules: ['MATCH,T'],
};
fs.writeFileSync(path.join(目录, 'verify.yaml'), yaml.dump(配置, { lineWidth: 4096 }));

const 子进程 = spawn(BIN, ['-d', 目录, '-f', path.join(目录, 'verify.yaml')], { stdio: ['ignore', 'pipe', 'pipe'] });
let 内核日志 = '';
子进程.stdout.on('data', (d) => (内核日志 += d));
子进程.stderr.on('data', (d) => (内核日志 += d));

let 就绪 = false;
for (let i = 0; i < 30; i++) { await 睡(1000); try { if ((await fetch(`${API}/version`)).ok) { 就绪 = true; break; } } catch { } }
if (!就绪) { console.error('内核未就绪：', 内核日志.slice(-400)); 子进程.kill('SIGKILL'); process.exit(0); }

// ---------- 逐个真打 ----------
const 结果 = [];
for (const n of 名) {
  const t0 = Date.now();
  let ok = false, ms = -1, 原因 = '';
  try {
    await fetch(`${API}/proxies/T`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) });
    await 睡(80);
    const r = await fetch(测试URL, { redirect: 'manual', signal: AbortSignal.timeout(超时ms) });
    ok = r.status === 204;
    ms = Date.now() - t0;
    if (!ok) 原因 = `HTTP ${r.status}`;
  } catch (e) {
    原因 = String(e.message || e).slice(0, 40);
  }
  结果.push({ name: n, ok, ms });
}
子进程.kill('SIGKILL');

// ---------- 更新台账 ----------
const at = new Date().toISOString();
for (const r of 结果) {
  const 原名 = r.name.replace(/^\d+\|/, '');
  const h = 健康[原名] || { ok: 0, fail: 0, consecFail: 0, ms: null, at: null };
  if (r.ok) { h.ok += 1; h.consecFail = 0; h.ms = r.ms; }
  else { h.fail += 1; h.consecFail = (h.consecFail || 0) + 1; }
  h.at = at;
  健康[原名] = h;
}

const 通过 = 结果.filter((r) => r.ok);
日志(`真机通过 ${通过.length}/${结果.length} = ${((通过.length / Math.max(1, 结果.length)) * 100).toFixed(1)}%`);

// ---------- 产出 verified ----------
// ---------- 国内可达性（可选输入）----------
// 数据来源可以是任何探测服务或墙内自建探测机，只要格式是
//   { generatedAt, vantage, results: { "host:port": { ok: bool } } }
// 超过 CN_PROBE_MAX_AGE_HOURS 小时的视为过期，不参与筛选（避免用陈旧结论误杀节点）。
const CN探针文件 = process.env.CN_PROBE || path.join(DIST, 'cn-probe.json');
const CN最大年龄 = Number(process.env.CN_PROBE_MAX_AGE_HOURS || 36);
let CN不可达 = new Set();
let CN信息 = null;
try {
  const cn = JSON.parse(fs.readFileSync(CN探针文件, 'utf8'));
  const 年龄h = (Date.now() - Date.parse(cn.generatedAt || 0)) / 3600e3;
  if (年龄h <= CN最大年龄 && cn.results) {
    for (const [hp, v] of Object.entries(cn.results)) if (v && v.ok === false) CN不可达.add(hp);
    CN信息 = { vantage: cn.vantage, generatedAt: cn.generatedAt, ageHours: Number(年龄h.toFixed(1)), unreachable: CN不可达.size };
    日志(`国内探测（${cn.vantage}，${年龄h.toFixed(1)}h 前）：${CN不可达.size} 个 host:port 国内不可达`);
  } else {
    日志(`国内探测数据过期或缺失（${cn.generatedAt || '无时间戳'}），本轮不做国内筛选`);
  }
} catch {
  CN信息 = null;
  日志('没有 cn-probe.json，本轮不做国内筛选');
}

const 可用 = 全部.filter((p) => {
  const h = 健康[p.name];
  if (!h || h.ok <= 0 || (h.consecFail || 0) >= 最大失败) return false;
  if (CN不可达.has(`${p.server}:${p.port}`)) return false; // 国内连不上直接排除
  return true;
});
const 按地区 = new Map();
for (const p of 可用) {
  const r = 地区判定(p.name);
  if (!按地区.has(r)) 按地区.set(r, []);
  按地区.get(r).push(p);
}
const 精选 = [];
for (const [, list] of 按地区) {
  list.sort((a, b) => (健康[a.name]?.ms ?? 9e9) - (健康[b.name]?.ms ?? 9e9));
  精选.push(...list.slice(0, 产出每地区));
}
const 最终 = 精选.slice(0, 产出上限);

const 分组 = [
  { name: '🌐 公共节点', type: 'select', proxies: ['♻️ 全部-自动', '☝️ 全部-手动', ...[...按地区.keys()].map((r) => `📍 ${r}`), 'DIRECT'] },
  { name: '♻️ 全部-自动', type: 'url-test', url: 测试URL, interval: 900, tolerance: 100, lazy: true, proxies: 最终.map((p) => p.name) },
  { name: '☝️ 全部-手动', type: 'select', proxies: 最终.map((p) => p.name) },
];
for (const [r, list] of 按地区) {
  const 命中 = 最终.filter((p) => 地区判定(p.name) === r).map((p) => p.name);
  if (命中.length < 5) continue;
  分组.push({ name: `📍 ${r}`, type: 'url-test', url: 测试URL, interval: 1800, tolerance: 100, lazy: true, proxies: 命中 });
}

const 报告 = {
  generatedAt: at,
  source: path.basename(源文件),
  sourceNodes: 全部.length,
  sampled: 结果.length,
  passed: 通过.length,
  passRate: Number(((通过.length / Math.max(1, 结果.length)) * 100).toFixed(1)),
  medianMs: 通过.length ? 通过.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(通过.length / 2)] : null,
  byRegion: Object.fromEntries([...按地区.entries()].map(([r, l]) => [r, l.length])),
  verifiedNodes: 最终.length,
  healthTracked: Object.keys(健康).length,
  cnProbe: CN信息,
  deadThisRound: 结果.filter((r) => !r.ok).map((r) => ({ name: r.name.replace(/^\d+\|/, '') })).slice(0, 20),
};

fs.writeFileSync(健康文件, JSON.stringify(健康, null, 0) + '\n');
fs.writeFileSync(报告文件, JSON.stringify(报告, null, 2) + '\n');
if (最终.length >= 20) {
  fs.writeFileSync(
    产物,
    yaml.dump({
      'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'warning',
      'unified-delay': true, 'tcp-concurrent': true,
      proxies: 最终, 'proxy-groups': 分组, rules: ['MATCH,🌐 公共节点'],
    }, { lineWidth: 4096, noRefs: true })
  );
  日志(`写出 ${path.basename(产物)}：${最终.length} 个真机验证过的节点`);
} else {
  console.error(`可用节点只有 ${最终.length} 个，不覆盖 ${path.basename(产物)}`);
}
日志(JSON.stringify({ passRate: 报告.passRate, medianMs: 报告.medianMs, verified: 最终.length }));
