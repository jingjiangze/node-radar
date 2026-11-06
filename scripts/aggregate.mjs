#!/usr/bin/env node
// 公开节点聚合器 v2
// 改进点：
//   1) 地区分组（按节点名归类，产出独立地区组）
//   2) 空/异常结果兜底：可用节点少于阈值时不覆盖线上 dist，保留上一版
//   3) 源健康度：连续失败 3 次的自动源自动剔除（人工策展的 sources.json 不动）
//   4) 探活只剔除「TCP 连不上」的死服务器，不做排序、不判地区（CI 在美国，判国内可达会误杀）

import fs from 'node:fs';
import yaml from 'js-yaml';

const loadList = (f, fallback = []) => { try { return JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8')); } catch { return fallback; } };
const curated = loadList('../sources.json');
const auto = loadList('../sources.auto.json');
const health = loadList('../sources.health.json', {});

const seenUrl = new Set();
const SOURCES = [...curated, ...auto]
  .filter((s) => (seenUrl.has(s.url) ? false : (seenUrl.add(s.url), true)))
  .filter((s) => {
    const h = health[s.url];
    // 只对「自动发现」的源做剔除；人工策展的永不自动删
    const isCurated = curated.some((c) => c.url === s.url);
    return isCurated || !h || (h.fails || 0) < 3;
  });

const UA = 'clash-verge/aggregator (+https://github.com/jingjiangze/node-radar)';
const TIMEOUT_MS = 30000;
const MIN_HEALTHY = 100;          // 低于这个数认为本次抓取异常，不覆盖线上
const MIN_REGION = 10;            // 地区组最少节点数

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

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

const b64d = (s) => Buffer.from(s.replace(/[-_]/g, (c) => (c === '-' ? '+' : '/')), 'base64').toString('utf8');

function parseVless(u) {
  const url = new URL(u); const q = url.searchParams;
  const p = { name: decodeURIComponent(url.hash.slice(1)) || `vless-${url.hostname}`, type: 'vless', server: url.hostname, port: Number(url.port || 443), uuid: decodeURIComponent(url.username), udp: true };
  if (q.get('security') === 'tls' || q.get('security') === 'reality') {
    p.tls = true;
    if (q.get('sni')) p.servername = q.get('sni');
    if (q.get('fp')) p['client-fingerprint'] = q.get('fp');
    if (q.get('alpn')) p.alpn = q.get('alpn').split(',');
    if (q.get('allowInsecure') === '1') p['skip-cert-verify'] = true;
    if (q.get('security') === 'reality') {
      const pbk = q.get('pbk');
      if (!pbk || !/^[A-Za-z0-9_-]{43}$/.test(pbk)) return null;   // 缺 public-key 或格式非法
      p['reality-opts'] = { 'public-key': pbk };
      if (q.get('sid')) p['reality-opts']['short-id'] = q.get('sid');
    }
  }
  const net = q.get('type') || 'tcp';
  if (net === 'ws') { p.network = 'ws'; p['ws-opts'] = { path: q.get('path') || '/' }; if (q.get('host')) p['ws-opts'].headers = { Host: q.get('host') }; }
  else if (net === 'grpc') { p.network = 'grpc'; p['grpc-opts'] = { 'grpc-service-name': q.get('serviceName') || '' }; }
  else if (net === 'h2') { p.network = 'h2'; p['h2-opts'] = { path: q.get('path') || '/' }; if (q.get('host')) p['h2-opts'].host = [q.get('host')]; }
  return p;
}
function parseTrojan(u) {
  const url = new URL(u); const q = url.searchParams;
  const p = { name: decodeURIComponent(url.hash.slice(1)) || `trojan-${url.hostname}`, type: 'trojan', server: url.hostname, port: Number(url.port || 443), password: decodeURIComponent(url.username), udp: true };
  if (q.get('sni')) p.sni = q.get('sni');
  if (q.get('allowInsecure') === '1') p['skip-cert-verify'] = true;
  if (q.get('type') === 'ws') { p.network = 'ws'; p['ws-opts'] = { path: q.get('path') || '/' }; if (q.get('host')) p['ws-opts'].headers = { Host: q.get('host') }; }
  return p;
}
function parseSS(u) {
  const raw = u.slice(5).split('#')[0];
  const name = u.includes('#') ? decodeURIComponent(u.split('#').slice(1).join('#')) : null;
  let method, password, host, port;
  if (raw.includes('@')) { const [b64, hostport] = raw.split('@'); const dec = b64d(b64); [method, password] = dec.split(':'); [host, port] = hostport.split(':'); }
  else { const dec = b64d(raw); const at = dec.lastIndexOf('@'); if (at < 0) return null; [host, port] = dec.slice(at + 1).split(':'); const mp = dec.slice(0, at); const ci = mp.indexOf(':'); method = mp.slice(0, ci); password = mp.slice(ci + 1); }
  if (!host || !port || !method) return null;
  return { name: name || `ss-${host}`, type: 'ss', server: host, port: Number(port), cipher: method, password, udp: true };
}
function parseHysteria2(u) {
  const url = new URL(u); const q = url.searchParams;
  const p = { name: decodeURIComponent(url.hash.slice(1)) || `hy2-${url.hostname}`, type: 'hysteria2', server: url.hostname, port: Number(url.port || 443), password: decodeURIComponent(url.username || '') };
  if (q.get('sni')) p.sni = q.get('sni');
  if (q.get('insecure') === '1') p['skip-cert-verify'] = true;
  const obfs = q.get('obfs'), obfsPwd = q.get('obfs-password');
  if (obfs && obfsPwd) { p.obfs = obfs; p['obfs-password'] = obfsPwd; } // 缺 password 会导致整份配置加载失败
  return p;
}
function parseVmess(u) {
  let j; try { j = JSON.parse(b64d(u.slice(8).split('#')[0])); } catch { return null; }
  if (!j.add || !j.port || !j.id) return null;
  const p = { name: j.ps || `vmess-${j.add}`, type: 'vmess', server: j.add, port: Number(j.port), uuid: j.id, alterId: Number(j.aid || 0), cipher: 'auto', udp: true };
  if (j.tls === 'tls') { p.tls = true; if (j.sni) p.servername = j.sni; else if (j.host) p.servername = j.host; }
  if (j.net === 'ws') { p.network = 'ws'; p['ws-opts'] = { path: j.path || '/' }; if (j.host) p['ws-opts'].headers = { Host: j.host }; }
  else if (j.net === 'grpc') { p.network = 'grpc'; p['grpc-opts'] = { 'grpc-service-name': j.path || '' }; }
  return p;
}
function parseUri(line) {
  const u = line.trim();
  try {
    if (u.startsWith('vless://')) return parseVless(u);
    if (u.startsWith('trojan://')) return parseTrojan(u);
    if (u.startsWith('ss://')) return parseSS(u);
    if (u.startsWith('hysteria2://') || u.startsWith('hy2://')) return parseHysteria2(u);
    if (u.startsWith('vmess://')) return parseVmess(u);
  } catch { return null; }
  return null;
}

// ---------- 抓取 ----------
const collected = [];
const stats = [];
const nextHealth = { ...health };

for (const src of SOURCES) {
  try {
    const text = await fetchText(src.url);
    let proxies = [], kind = 'unknown';
    if (/^\s*(proxies|mixed-port|port|socks-port|allow-lan)\s*:/m.test(text)) {
      kind = 'clash-yaml';
      const doc = yaml.load(text);
      proxies = Array.isArray(doc?.proxies) ? doc.proxies : [];
    } else {
      kind = 'uri-list';
      let decoded = text.trim();
      if (!/^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//m.test(decoded)) { try { decoded = b64d(decoded); } catch { } }
      proxies = decoded.split(/\r?\n/).map(parseUri).filter(Boolean);
    }
    proxies = proxies
      .filter((p) => p && typeof p === 'object' && p.server && p.port && p.type)
      .map((p) => { const q = { ...p }; delete q.name; return { name: String(p.name || `${p.type}-${p.server}`).slice(0, 60), ...q }; });

    stats.push({ source: src.name, kind, count: proxies.length, ok: true });
    collected.push(...proxies);
    nextHealth[src.url] = { fails: 0, ok: true, at: new Date().toISOString() };
  } catch (e) {
    stats.push({ source: src.name, ok: false, error: String(e.message || e).slice(0, 80) });
    const prev = nextHealth[src.url] || { fails: 0 };
    nextHealth[src.url] = { fails: (prev.fails || 0) + 1, ok: false, at: new Date().toISOString() };
  }
}
fs.writeFileSync(new URL('../sources.health.json', import.meta.url), JSON.stringify(nextHealth, null, 2) + '\n');

// ---------- 去重 ----------
const seen = new Set(); const unique = [];
// REALITY 公钥必须是 32 字节 base64url（43 字符），short-id 必须是 <=16 位 hex；否则内核拒绝加载整份配置
const okReality = (p) => {
  const ro = p['reality-opts'];
  if (!ro) return true;
  const k = ro['public-key'];
  if (typeof k !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(k)) return false;
  const sid = ro['short-id'];
  if (sid !== undefined && sid !== null && !/^[0-9a-fA-F]{0,16}$/.test(String(sid))) return false;
  return true;
};
const invalid = (p) =>
  ((p.type === 'hysteria2' || p.type === 'hysteria') && p.obfs && !p['obfs-password']) ||
  !okReality(p);
for (const p of collected) {
  if (invalid(p)) continue;
  const key = [p.type, p.server, p.port, p.uuid || p.password || p.cipher || ''].join('|').toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key); unique.push(p);
}

// ---------- 探活（只剔死服务器） ----------
async function probeTcp(host, port, timeout = 2500) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const fin = (ok) => { if (done) return; done = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => fin(false));
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
  });
}
let alive = unique; let probeInfo = { enabled: false };
if (process.env.PROBE !== '0') {
  const t0 = Date.now();
  const flags = new Array(unique.length).fill(false);
  let idx = 0;
  await Promise.all(Array.from({ length: 150 }, async () => {
    while (idx < unique.length) { const i = idx++; flags[i] = await probeTcp(unique[i].server, unique[i].port); }
  }));
  alive = unique.filter((_, i) => flags[i]);
  probeInfo = { enabled: true, probed: unique.length, alive: alive.length, ms: Date.now() - t0 };
}

// ---------- 名字去重 ----------
const nameCount = new Map();
for (const p of alive) {
  const n = p.name || 'node';
  const c = nameCount.get(n) || 0;
  nameCount.set(n, c + 1);
  if (c > 0) p.name = `${n}-${c + 1}`;
}

// ---------- 地区归类 ----------
const regionOf = (name) => {
  for (const [r, re] of REGIONS) if (re.test(name)) return r;
  return null;
};
const byRegion = {};
for (const p of alive) {
  const r = regionOf(p.name);
  if (!r) continue;
  (byRegion[r] = byRegion[r] || []).push(p.name);
}

// ---------- 组装 ----------
const groups = [];
groups.push({ name: '🌐 公共节点', type: 'select', proxies: ['♻️ 全部-自动', '☝️ 全部-手动', ...Object.keys(byRegion).filter((r) => byRegion[r].length >= MIN_REGION).map((r) => `📍 ${r}`), 'DIRECT'] });
groups.push({ name: '♻️ 全部-自动', type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 900, tolerance: 100, lazy: true, proxies: alive.map((p) => p.name) });
groups.push({ name: '☝️ 全部-手动', type: 'select', proxies: alive.map((p) => p.name) });
for (const [r, names] of Object.entries(byRegion)) {
  if (names.length < MIN_REGION) continue;
  groups.push({ name: `📍 ${r}`, type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 1800, tolerance: 100, lazy: true, proxies: names });
}

const out = {
  'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'warning',
  'unified-delay': true, 'tcp-concurrent': true,
  proxies: alive, 'proxy-groups': groups, rules: ['MATCH,🌐 公共节点'],
};

// ---------- 精简池 ----------
// 客户端一次性对所有节点做健康检查会大面积超时（实测：23 个 1.3s 通过，918 个 8s 仍超时），
// 所以另出一份按地区分层的精简池给订阅使用；全量池仍保留在 clash.yaml。
const LITE_PER_REGION = 25;
const LITE_MAX = 300;
const liteNames = new Set();
for (const names of Object.values(byRegion)) {
  if (liteNames.size >= LITE_MAX) break;
  for (const n of [...names].sort().slice(0, LITE_PER_REGION)) {
    if (liteNames.size >= LITE_MAX) break;
    liteNames.add(n);
  }
}
const liteAlive = alive.filter((p) => liteNames.has(p.name));
const liteGroups = [
  { name: '🌐 公共节点', type: 'select', proxies: ['♻️ 全部-自动', '☝️ 全部-手动', ...Object.keys(byRegion).filter((r) => byRegion[r].filter((n) => liteNames.has(n)).length >= MIN_REGION).map((r) => `📍 ${r}`), 'DIRECT'] },
  { name: '♻️ 全部-自动', type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 900, tolerance: 100, lazy: true, proxies: liteAlive.map((p) => p.name) },
  { name: '☝️ 全部-手动', type: 'select', proxies: liteAlive.map((p) => p.name) },
];
for (const [r, names] of Object.entries(byRegion)) {
  const inLite = names.filter((n) => liteNames.has(n));
  if (inLite.length < MIN_REGION) continue;
  liteGroups.push({ name: `📍 ${r}`, type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 1800, tolerance: 100, lazy: true, proxies: inLite });
}
const outLite = {
  'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'warning',
  'unified-delay': true, 'tcp-concurrent': true,
  proxies: liteAlive, 'proxy-groups': liteGroups, rules: ['MATCH,🌐 公共节点'],
};

const summary = {
  generatedAt: new Date().toISOString(),
  totalRaw: collected.length,
  totalUnique: unique.length,
  totalAlive: alive.length,
  probe: probeInfo,
  regions: Object.fromEntries(Object.entries(byRegion).map(([k, v]) => [k, v.length])),
  byType: alive.reduce((a, p) => ((a[p.type] = (a[p.type] || 0) + 1), a), {}),
  sources: stats,
  degraded: alive.length < MIN_HEALTHY,
};

// ---------- 兜底：结果异常时不覆盖线上 ----------
const distDir = new URL('../dist/', import.meta.url);
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(new URL('summary.json', distDir), JSON.stringify(summary, null, 2));

if (summary.degraded) {
  console.error(`[GUARD] 可用节点只有 ${alive.length} < ${MIN_HEALTHY}，本次不覆盖线上订阅，保留上一版`);
  fs.writeFileSync(new URL('clash.candidate.yaml', distDir), yaml.dump(out, { lineWidth: 4096, noRefs: true }));
} else {
  fs.writeFileSync(new URL('clash.yaml', distDir), yaml.dump(out, { lineWidth: 4096, noRefs: true }));
  fs.writeFileSync(new URL('clash-lite.yaml', distDir), yaml.dump(outLite, { lineWidth: 4096, noRefs: true }));
  console.log(`发布 ${alive.length} 节点，地区组 ${Object.keys(byRegion).length} 个；精简池 ${liteAlive.length} 节点`);
}
console.log(JSON.stringify({ ...summary, sources: undefined }, null, 2));
