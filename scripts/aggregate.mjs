#!/usr/bin/env node
// 公开节点聚合器：抓取多个公开源 → 解析 → 去重 → 输出一份 Clash 订阅
// 仅做「格式转换 + 去重」，不做存活探测（探测会拖慢 CI 且节点随时失效）

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const SOURCES = JSON.parse(fs.readFileSync(new URL('../sources.json', import.meta.url), 'utf8'));

const UA = 'clash-verge/aggregator (+https://github.com/jingjiangze/node-pool-aggregator)';
const TIMEOUT_MS = 30000;

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

// ---------- URI → Clash proxy ----------
function b64d(s) {
  const norm = s.replace(/[-_]/g, (c) => (c === '-' ? '+' : '/'));
  return Buffer.from(norm, 'base64').toString('utf8');
}

function parseVless(u) {
  const url = new URL(u);
  const q = url.searchParams;
  const p = {
    name: decodeURIComponent(url.hash.slice(1)) || `vless-${url.hostname}`,
    type: 'vless',
    server: url.hostname,
    port: Number(url.port || 443),
    uuid: decodeURIComponent(url.username),
    udp: true,
  };
  if (q.get('security') === 'tls' || q.get('security') === 'reality') {
    p.tls = true;
    if (q.get('sni')) p.servername = q.get('sni');
    if (q.get('fp')) p['client-fingerprint'] = q.get('fp');
    if (q.get('alpn')) p.alpn = q.get('alpn').split(',');
    if (q.get('allowInsecure') === '1') p['skip-cert-verify'] = true;
    if (q.get('security') === 'reality') {
      p['reality-opts'] = {};
      if (q.get('pbk')) p['reality-opts']['public-key'] = q.get('pbk');
      if (q.get('sid')) p['reality-opts']['short-id'] = q.get('sid');
    }
  }
  const net = q.get('type') || 'tcp';
  if (net === 'ws') {
    p.network = 'ws';
    p['ws-opts'] = { path: q.get('path') || '/' };
    if (q.get('host')) p['ws-opts'].headers = { Host: q.get('host') };
  } else if (net === 'grpc') {
    p.network = 'grpc';
    p['grpc-opts'] = { 'grpc-service-name': q.get('serviceName') || '' };
  } else if (net === 'h2') {
    p.network = 'h2';
    p['h2-opts'] = { path: q.get('path') || '/' };
    if (q.get('host')) p['h2-opts'].host = [q.get('host')];
  }
  return p;
}

function parseTrojan(u) {
  const url = new URL(u);
  const q = url.searchParams;
  const p = {
    name: decodeURIComponent(url.hash.slice(1)) || `trojan-${url.hostname}`,
    type: 'trojan',
    server: url.hostname,
    port: Number(url.port || 443),
    password: decodeURIComponent(url.username),
    udp: true,
  };
  if (q.get('sni')) p.sni = q.get('sni');
  if (q.get('allowInsecure') === '1') p['skip-cert-verify'] = true;
  if (q.get('type') === 'ws') {
    p.network = 'ws';
    p['ws-opts'] = { path: q.get('path') || '/' };
    if (q.get('host')) p['ws-opts'].headers = { Host: q.get('host') };
  }
  return p;
}

function parseSS(u) {
  // ss://base64(method:pass)@host:port#name  或  ss://base64(method:pass@host:port)#name
  const raw = u.slice(5).split('#')[0];
  const name = u.includes('#') ? decodeURIComponent(u.split('#').slice(1).join('#')) : null;
  let method, password, host, port;
  if (raw.includes('@')) {
    const [b64, hostport] = raw.split('@');
    const dec = b64d(b64);
    [method, password] = dec.split(':');
    [host, port] = hostport.split(':');
  } else {
    const dec = b64d(raw);
    const at = dec.lastIndexOf('@');
    if (at < 0) return null;
    [host, port] = dec.slice(at + 1).split(':');
    const mp = dec.slice(0, at);
    const ci = mp.indexOf(':');
    method = mp.slice(0, ci);
    password = mp.slice(ci + 1);
  }
  if (!host || !port || !method) return null;
  return { name: name || `ss-${host}`, type: 'ss', server: host, port: Number(port), cipher: method, password, udp: true };
}

function parseHysteria2(u) {
  const url = new URL(u);
  const q = url.searchParams;
  const p = {
    name: decodeURIComponent(url.hash.slice(1)) || `hy2-${url.hostname}`,
    type: 'hysteria2',
    server: url.hostname,
    port: Number(url.port || 443),
    password: decodeURIComponent(url.username || ''),
  };
  if (q.get('sni')) p.sni = q.get('sni');
  if (q.get('insecure') === '1') p['skip-cert-verify'] = true;
  if (q.get('obfs')) { p.obfs = q.get('obfs'); if (q.get('obfs-password')) p['obfs-password'] = q.get('obfs-password'); }
  return p;
}

function parseVmess(u) {
  const b64 = u.slice(8).split('#')[0];
  let j;
  try { j = JSON.parse(b64d(b64)); } catch { return null; }
  if (!j.add || !j.port || !j.id) return null;
  const p = {
    name: j.ps || `vmess-${j.add}`,
    type: 'vmess',
    server: j.add,
    port: Number(j.port),
    uuid: j.id,
    alterId: Number(j.aid || 0),
    cipher: 'auto',
    udp: true,
  };
  if (j.tls === 'tls') { p.tls = true; if (j.sni) p.servername = j.sni; if (j.host) p.servername = p.servername || j.host; }
  if (j.net === 'ws') {
    p.network = 'ws';
    p['ws-opts'] = { path: j.path || '/' };
    if (j.host) p['ws-opts'].headers = { Host: j.host };
  } else if (j.net === 'grpc') {
    p.network = 'grpc';
    p['grpc-opts'] = { 'grpc-service-name': j.path || '' };
  }
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

// ---------- 主流程 ----------
const collected = [];
const stats = [];

for (const src of SOURCES) {
  try {
    const text = await fetchText(src.url);
    let proxies = [];
    let kind = 'unknown';

    if (/^\s*(proxies|mixed-port|port|socks-port|allow-lan)\s*:/m.test(text)) {
      kind = 'clash-yaml';
      const doc = yaml.load(text);
      proxies = Array.isArray(doc?.proxies) ? doc.proxies : [];
    } else {
      kind = 'uri-list';
      let decoded = text.trim();
      if (!/^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//m.test(decoded)) {
        try { decoded = b64d(decoded); } catch { }
      }
      proxies = decoded.split(/\r?\n/).map(parseUri).filter(Boolean);
    }

    proxies = proxies
      .filter((p) => p && typeof p === 'object' && p.server && p.port && p.type)
      .map((p) => {
        const q = { ...p };
        delete q.name;
        return { name: String(p.name || `${p.type}-${p.server}`).slice(0, 60), ...q };
      });

    stats.push({ source: src.name, kind, count: proxies.length, ok: true });
    collected.push(...proxies);
  } catch (e) {
    stats.push({ source: src.name, ok: false, error: String(e.message || e).slice(0, 80) });
  }
}

// 去重：同 type+server+port+凭证 视为同一节点
const seen = new Set();
const unique = [];
for (const p of collected) {
  const cred = p.uuid || p.password || p.cipher || '';
  const key = [p.type, p.server, p.port, cred].join('|').toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(p);
}

// ---------- CI 探活：只剔除 TCP 连不上的死服务器 ----------
// 注意：GitHub runner 在美国，探不到不代表国内用不了（GFW 只影响国内侧），
// 所以这里只用来剔除「服务器已经挂了」的节点，不做排序、不做地区判断。
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

async function probeAll(list, concurrency = 150) {
  const flags = new Array(list.length).fill(false);
  let idx = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (idx < list.length) {
      const i = idx++;
      flags[i] = await probeTcp(list[i].server, list[i].port);
    }
  }));
  return flags;
}

let alive = unique;
let probeInfo = { enabled: false };
if (process.env.PROBE !== '0') {
  const t0 = Date.now();
  const flags = await probeAll(unique);
  alive = unique.filter((_, i) => flags[i]);
  probeInfo = { enabled: true, probed: unique.length, alive: alive.length, ms: Date.now() - t0 };
}

// 名字去重
const nameCount = new Map();
for (const p of alive) {
  const n = p.name || 'node';
  const c = nameCount.get(n) || 0;
  nameCount.set(n, c + 1);
  if (c > 0) p.name = `${n}-${c + 1}`;
}

const groups = [
  { name: '🚀 聚合选择', type: 'select', proxies: ['♻️ 自动测速', 'DIRECT'] },
  { name: '♻️ 自动测速', type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 900, tolerance: 100, lazy: true, proxies: alive.map((p) => p.name) },
];

const out = {
  'mixed-port': 7890,
  'allow-lan': false,
  mode: 'rule',
  'log-level': 'warning',
  'unified-delay': true,
  'tcp-concurrent': true,
  proxies: alive,
  'proxy-groups': groups,
  rules: ['MATCH,🚀 聚合选择'],
};

const distDir = new URL('../dist/', import.meta.url);
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(new URL('clash.yaml', distDir), yaml.dump(out, { lineWidth: 4096, noRefs: true }));

const summary = {
  generatedAt: new Date().toISOString(),
  totalRaw: collected.length,
  totalUnique: unique.length,
  totalAlive: alive.length,
  probe: probeInfo,
  byType: alive.reduce((a, p) => ((a[p.type] = (a[p.type] || 0) + 1), a), {}),
  sources: stats,
};
fs.writeFileSync(new URL('summary.json', distDir), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
