// CN 侧公开节点协议级筛选（分块版）
//
// 设计：不再每天一次性扫 3,074 个（16 分钟满载），改成「每 10 分钟测一小片」，
// 滚动覆盖整个池子：CHUNK=120、10 分钟一轮 ⇒ 约 4.3 小时轮完一遍，单轮只占 ~1 分钟 CPU。
// 每轮把结果 merge 进 out/results.json，再从「最近 RECENT_HOURS 内测过且通过」的节点里
// 按延迟重建 clash.yaml / topN.yaml —— 所以池子始终是「最近测过的可用节点」。
//
// 环境变量：
//   CHUNK        每轮测多少个（默认 120）
//   CONC         并发（默认 3，故意压低：不抢百度那 2.5Mbps 上行）
//   TIMEOUT      单节点超时 ms（默认 5000）
//   TOP_N        下发给路由器的条数（默认 20）
//   RECENT_HOURS 只认最近多少小时内测过的结果（默认 12）
//   MIN_PASS     通过数低于它就不覆盖产物（默认 30）
//   POOL_SRC     池子地址（默认 gcore jsDelivr，raw.githubusercontent 在国内不通）
//   LIMIT        只测前 N 个，调试用，不写产物
//   PROBE_VIA_HOME=1  走家宽出口（需路由器反向 SOCKS；默认关闭）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let yaml;
try { yaml = require('js-yaml'); } catch { yaml = createRequire('/opt/poolfilter/')('js-yaml'); }

const SRC = process.env.POOL_SRC || 'https://gcore.jsdelivr.net/gh/jingjiangze/node-radar@main/dist/clash.yaml';
const OUT = process.env.OUT_DIR || '/opt/poolfilter/out';
const MHDIR = process.env.MH_DIR || '/opt/poolfilter/mh';
const MIHOMO = process.env.MIHOMO_BIN || '/opt/mihomo/mihomo';
const API = 'http://127.0.0.1:9191';
const TEST_URL = process.env.TEST_URL || 'https://www.gstatic.com/generate_204';
const CHUNK = Number(process.env.CHUNK || 120);
const CONC = Number(process.env.CONC || 3);
const TIMEOUT = Number(process.env.TIMEOUT || 5000);
const TOP_N = Number(process.env.TOP_N || 20);
const RECENT_HOURS = Number(process.env.RECENT_HOURS || 12);
const MIN_PASS = Number(process.env.MIN_PASS || 30);
const LIMIT = Number(process.env.LIMIT || 0);
const VIA_HOME = process.env.PROBE_VIA_HOME === '1';

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(MHDIR, { recursive: true });
const STATE = path.join(OUT, 'state.json');
const RESULTS = path.join(OUT, 'results.json');

const t0 = Date.now();
const res = await fetch(SRC, { headers: { 'user-agent': 'node-radar-poolfilter/2.0' } });
if (!res.ok) throw new Error(`下载池失败 ${res.status}`);
const doc = yaml.load(await res.text());
const all = (doc.proxies || []).filter((p) => p && p.server && p.port);
const seen = new Set();
const proxies = all.filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));

// 状态与历史结果
let state = { cursor: 0 };
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
let store = { updatedAt: null, results: {} };
try { store = JSON.parse(fs.readFileSync(RESULTS, 'utf8')); } catch {}

const limit = LIMIT || CHUNK;
const start = LIMIT ? 0 : ((state.cursor || 0) % proxies.length);
const slice = [];
for (let i = 0; i < limit && i < proxies.length; i++) slice.push(proxies[(start + i) % proxies.length]);
console.log(`池 ${proxies.length} | 本轮 slice ${start}..${start + slice.length - 1} (${slice.length} 个)` + (LIMIT ? ' [LIMIT 调试，不写产物]' : ''));

// 起临时 mihomo，只装这一片的节点
const proxiesWithHome = VIA_HOME
  ? [{ name: 'HOME', type: 'socks5', server: '127.0.0.1', port: Number(process.env.HOME_PORT || 11080), udp: false },
     ...slice.map((p) => ({ ...p, 'dialer-proxy': 'HOME' }))]
  : slice;
const cfg = { 'mixed-port': 7899, 'allow-lan': false, mode: 'global', 'log-level': 'warning', 'external-controller': '127.0.0.1:9191', proxies: proxiesWithHome };
fs.writeFileSync(path.join(MHDIR, 'config.yaml'), yaml.dump(cfg, { lineWidth: 400 }));

const mh = spawn(MIHOMO, ['-d', MHDIR, '-f', path.join(MHDIR, 'config.yaml')], {
  stdio: ['ignore', fs.openSync(path.join(MHDIR, 'mihomo.log'), 'w'), fs.openSync(path.join(MHDIR, 'mihomo.log'), 'a')],
});
const stop = () => { try { mh.kill('SIGKILL'); } catch {} };
process.on('exit', stop);
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(API + '/version', { signal: AbortSignal.timeout(1500) })).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 300));
}

const u = encodeURIComponent(TEST_URL);
const now = Date.now();
let idx = 0, done = 0, pass = 0;
async function worker() {
  while (idx < slice.length) {
    const p = slice[idx++];
    let delay = 0;
    try {
      const r = await fetch(`${API}/proxies/${encodeURIComponent(p.name)}/delay?timeout=${TIMEOUT}&url=${u}`, { signal: AbortSignal.timeout(TIMEOUT + 4000) });
      const o = await r.json();
      if (typeof o.delay === 'number' && o.delay > 0) delay = o.delay;
    } catch {}
    if (delay > 0) pass++;
    store.results[p.name] = { delay, at: now, server: p.server, port: p.port, type: p.type };
    if (++done % 40 === 0) console.log(`  ${done}/${slice.length}，通过 ${pass}，${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
stop();
console.log(`本轮通过 ${pass}/${slice.length}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);

if (LIMIT) { console.log('LIMIT 模式，不写产物'); process.exit(0); }

// 滚动窗口：只保留最近 RECENT_HOURS 内测过的、且仍在当前池里的节点
const cutoff = Date.now() - RECENT_HOURS * 3600e3;
const alive = new Map(proxies.map((p) => [p.name, p]));
const recent = {};
for (const [name, v] of Object.entries(store.results)) {
  if (!alive.has(name)) continue;
  if (!v || v.at < cutoff) continue;
  recent[name] = v;
}
store = { updatedAt: new Date().toISOString(), results: recent };
fs.writeFileSync(RESULTS, JSON.stringify(store));

const ok = Object.entries(recent).filter(([, v]) => v.delay > 0).sort((a, b) => a[1].delay - b[1].delay);
console.log(`最近 ${RECENT_HOURS}h 内测过 ${Object.keys(recent).length} 个，通过 ${ok.length}`);

state.cursor = (start + slice.length) % proxies.length;
state.updatedAt = new Date().toISOString();
fs.writeFileSync(STATE, JSON.stringify(state));

if (ok.length < MIN_PASS) {
  console.log(`通过数 ${ok.length} < MIN_PASS ${MIN_PASS}，保留上一版产物`);
  fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify({ generatedAt: new Date().toISOString(), stale: true, total: proxies.length, recent: Object.keys(recent).length, passed: ok.length, cursor: state.cursor }, null, 1));
  process.exit(0);
}

const pick = (n) => ok.slice(0, n).map(([name]) => alive.get(name)).filter(Boolean);
fs.writeFileSync(path.join(OUT, 'clash.yaml'), yaml.dump({ proxies: pick(ok.length) }, { lineWidth: 400 }));
fs.writeFileSync(path.join(OUT, `top${TOP_N}.yaml`), yaml.dump({ proxies: pick(TOP_N) }, { lineWidth: 400 }));
fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  stale: false,
  source: SRC,
  pool: proxies.length,
  cursor: state.cursor,
  chunk: slice.length,
  recent: Object.keys(recent).length,
  passed: ok.length,
  topN: TOP_N,
  fastest: ok.slice(0, 30).map(([name, v]) => ({ name, delay: v.delay, ageMin: Math.round((Date.now() - v.at) / 60000) })),
}, null, 1));
console.log(`已写 clash.yaml（${ok.length}）与 top${TOP_N}.yaml，cursor→${state.cursor}`);
