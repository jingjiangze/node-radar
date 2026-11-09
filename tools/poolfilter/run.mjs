// CN 侧公开节点协议级筛选（跑在百度服务器上，结果经 pool.jiangjiangze.icu 下发）
//
// 流程：拉 node-radar 的 dist/clash.yaml → 起临时 mihomo → 逐节点 /delay 测真实请求
//       → 按延迟排序 → 写 out/clash.yaml（全量）+ out/topN.yaml（给路由器当 provider）
//
// 环境变量：
//   POOL_SRC      池子地址（默认 gcore jsDelivr；raw.githubusercontent 在国内不可达）
//   TOP_N         给路由器用的 topN 条数（默认 20）
//   CONC          并发（默认 8，2 vCPU 的机器别再往上加）
//   TIMEOUT       单节点超时 ms（默认 5000）
//   LIMIT         只测前 N 个（调试用；>0 时不写任何产物）
//   MIN_PASS      最少通过数，低于它不覆盖旧产物（默认 30）
//   PROBE_VIA_HOME=1  走家宽出口（需要路由器反向 SOCKS，默认关闭；见 README「备用链路」）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  // 部署在 /opt/poolfilter 时用本地 node_modules
  yaml = createRequire('/opt/poolfilter/')('js-yaml');
}

const SRC = process.env.POOL_SRC || 'https://gcore.jsdelivr.net/gh/jingjiangze/node-radar@main/dist/clash.yaml';
const OUT = process.env.OUT_DIR || '/opt/poolfilter/out';
const MHDIR = process.env.MH_DIR || '/opt/poolfilter/mh';
const MIHOMO = process.env.MIHOMO_BIN || '/opt/mihomo/mihomo';
const API = 'http://127.0.0.1:9191';
const TEST_URL = process.env.TEST_URL || 'https://www.gstatic.com/generate_204';
const CONC = Number(process.env.CONC || 8);
const TIMEOUT = Number(process.env.TIMEOUT || 5000);
const TOP_N = Number(process.env.TOP_N || 20);
const LIMIT = Number(process.env.LIMIT || 0);
const MIN_PASS = Number(process.env.MIN_PASS || 30);
const VIA_HOME = process.env.PROBE_VIA_HOME === '1';

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(MHDIR, { recursive: true });

const t0 = Date.now();
const res = await fetch(SRC, { headers: { 'user-agent': 'node-radar-poolfilter/1.0' } });
if (!res.ok) throw new Error(`下载池失败 ${res.status}`);
const doc = yaml.load(await res.text());
const all = (doc.proxies || []).filter((p) => p && p.server && p.port);
const seen = new Set();
const proxies0 = all.filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
const proxies = LIMIT ? proxies0.slice(0, LIMIT) : proxies0;
console.log(`池节点 ${all.length}（去重 ${proxies0.length}，本轮测 ${proxies.length}）` + (LIMIT ? ' [LIMIT 调试模式，不写产物]' : ''));

// 家宽出口（备用，默认关闭）：给每个节点挂 dialer-proxy 指向 HOME 的 SOCKS
const proxiesWithHome = VIA_HOME
  ? [{ name: 'HOME', type: 'socks5', server: '127.0.0.1', port: Number(process.env.HOME_PORT || 11080), udp: false },
     ...proxies.map((p) => ({ ...p, 'dialer-proxy': 'HOME' }))]
  : proxies;

const cfg = {
  'mixed-port': 7899,
  'allow-lan': false,
  mode: 'global',
  'log-level': 'warning',
  'external-controller': '127.0.0.1:9191',
  proxies: proxiesWithHome,
};
fs.writeFileSync(path.join(MHDIR, 'config.yaml'), yaml.dump(cfg, { lineWidth: 400 }));

const mh = spawn(MIHOMO, ['-d', MHDIR, '-f', path.join(MHDIR, 'config.yaml')], {
  stdio: ['ignore', fs.openSync(path.join(MHDIR, 'mihomo.log'), 'w'), fs.openSync(path.join(MHDIR, 'mihomo.log'), 'a')],
});
const stop = () => { try { mh.kill('SIGKILL'); } catch {} };
process.on('exit', stop);

for (let i = 0; i < 40; i++) {
  try { if ((await fetch(API + '/version', { signal: AbortSignal.timeout(1500) })).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const u = encodeURIComponent(TEST_URL);
const results = [];
let idx = 0, done = 0;
async function worker() {
  while (idx < proxies.length) {
    const p = proxies[idx++];
    let delay = null, err = '';
    try {
      const r = await fetch(`${API}/proxies/${encodeURIComponent(p.name)}/delay?timeout=${TIMEOUT}&url=${u}`, { signal: AbortSignal.timeout(TIMEOUT + 4000) });
      const o = await r.json();
      if (typeof o.delay === 'number' && o.delay > 0) delay = o.delay; else err = String(o.message || 'err').slice(0, 60);
    } catch (e) { err = 'exception'; }
    results.push({ name: p.name, type: p.type, server: p.server, port: p.port, delay, err });
    if (++done % 200 === 0) console.log(`  进度 ${done}/${proxies.length}，通过 ${results.filter((x) => x.delay).length}，${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const ok = results.filter((r) => r.delay !== null).sort((a, b) => a.delay - b.delay);
console.log(`\n通过 ${ok.length}/${results.length}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
ok.slice(0, 10).forEach((r, i) => console.log(`  ${i + 1}. ${r.delay}ms ${String(r.type).padEnd(8)} ${r.name.slice(0, 40)}`));
stop();

if (LIMIT) { console.log('LIMIT 模式，不写产物'); process.exit(0); }
if (ok.length < MIN_PASS) {
  console.log(`通过数 ${ok.length} < MIN_PASS ${MIN_PASS}，保留上一版产物不覆盖`);
  fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify({ generatedAt: new Date().toISOString(), stale: true, source: SRC, total: results.length, passed: ok.length }, null, 1));
  process.exit(0);
}

const byName = new Map(proxies.map((p) => [p.name, p]));
const picked = (n) => ok.slice(0, n).map((r) => byName.get(r.name)).filter(Boolean);
fs.writeFileSync(path.join(OUT, 'clash.yaml'), yaml.dump({ proxies: picked(ok.length) }, { lineWidth: 400 }));
fs.writeFileSync(path.join(OUT, `top${TOP_N}.yaml`), yaml.dump({ proxies: picked(TOP_N) }, { lineWidth: 400 }));
fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  stale: false,
  source: SRC,
  total: results.length,
  passed: ok.length,
  topN: TOP_N,
  byType: ok.reduce((a, r) => (a[r.type] = (a[r.type] || 0) + 1, a), {}),
  fastest: ok.slice(0, 50).map((r) => ({ name: r.name, delay: r.delay })),
}, null, 1));
console.log(`已写 ${OUT}/clash.yaml（${ok.length}）与 top${TOP_N}.yaml`);
