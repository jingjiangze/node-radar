#!/usr/bin/env node
// 公开节点聚合器 v2
// 改进点：
//   1) 地区分组（按节点名归类，产出独立地区组）
//   2) 空/异常结果兜底：可用节点少于阈值时不覆盖线上 dist，保留上一版
//   3) 源健康度：连续失败 3 次的自动源自动剔除（人工策展的 sources.json 不动）
//   4) 探活只剔除「TCP 连不上」的死服务器，不做排序、不判地区（CI 在美国，判国内可达会误杀）

import fs from 'node:fs';
import yaml from 'js-yaml';
import { buildRules, 别名分组 } from './rules.mjs';
import { b64d, parseUri, invalid, dedupeKey } from './lib/proxy.mjs';
import { 日期变体 } from './lib/date-url.mjs';

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

// 按天换文件名的源（yoyapai / freeclashnode / mlfenx）用 ${Y}/${M}/${D}/${YMD} 占位：
// 先取今天，失败再取昨天（发布方常在当天稍晚才生成文件）
async function fetchOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
async function fetchText(url) {
  let last;
  for (const u of 日期变体(url)) {
    try { return await fetchOnce(u); } catch (e) { last = e; }
  }
  throw last;
}


// ---------- 抓取 ----------
const collected = [];
const stats = [];
const nextHealth = { ...health };

for (const src of SOURCES) {
  // 自家订阅永不作为公开聚合的源
  if (/jiangjiangze\.icu/i.test(src.url)) {
    stats.push({ source: src.name, kind: 'skipped', count: 0, ok: false, reason: '私有源，不参与公开聚合' });
    continue;
  }
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

// ---------- 私有节点硬闸 ----------
// 这份产物是公开的，绝不能出现自己的 edgetunnel 订阅节点（域名/UUID 都是凭据）。
// 双保险：采集时剔除 + 落盘前对整份 YAML 再断言一次，命中就让 CI 失败、不发布。
const 私有标记 = /jiangjiangze\.icu|a5dea14ad4de58|97c109c4c7e4be|82bcf5b8|13c20322|d474812e/i;
// 全文断言只看凭据：规则/分组里会出现 sub./dl.jiangjiangze.icu 这类公开端点，不算凭据
const 私有凭据 = /a5dea14ad4de58|97c109c4c7e4be|82bcf5b8|13c20322|d474812e|dingyue\.jiangjiangze\.icu|tl2?\.jiangjiangze\.icu/i;
const 是私有节点 = (p) => 私有标记.test(JSON.stringify(p));

let 剔除私有 = 0;
for (const p of collected) {
  if (是私有节点(p)) { 剔除私有++; continue; }
  if (invalid(p)) continue;
  const key = dedupeKey(p);
  if (seen.has(key)) continue;
  seen.add(key); unique.push(p);
}
if (剔除私有) console.error(`[GUARD] 剔除了 ${剔除私有} 个命中私有标记的节点`);

// ---------- 探活（只剔死服务器），顺带记 RTT 用于排序 ----------
// RTT 是「全部节点都有的实测值」，比抽样测速覆盖高得多；有 mbps 的仍然优先用 mbps。
async function probeTcp(host, port, timeout = 2500) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    let done = false;
    const fin = (ok) => { if (done) return; done = true; s.destroy(); resolve({ ok, ms: ok ? Date.now() - t0 : null }); };
    s.setTimeout(timeout, () => fin(false));
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
  });
}
let alive = unique; let probeInfo = { enabled: false };
const RTT = new Map(); // "host:port" -> ms
if (process.env.PROBE !== '0') {
  const t0 = Date.now();
  const flags = new Array(unique.length).fill(false);
  let idx = 0;
  await Promise.all(Array.from({ length: 150 }, async () => {
    while (idx < unique.length) {
      const i = idx++;
      const r = await probeTcp(unique[i].server, unique[i].port);
      flags[i] = r.ok;
      if (r.ok) RTT.set(`${unique[i].server}:${unique[i].port}`, r.ms);
    }
  }));
  alive = unique.filter((_, i) => flags[i]);
  probeInfo = { enabled: true, probed: unique.length, alive: alive.length, ms: Date.now() - t0 };
}

// ---------- TLS 握手 + 证书（1 个 RTT，能提前判掉必然 SSL 失败的节点）----------
async function probeTls(host, port, servername, timeout = 4000) {
  const tls = await import('node:tls');
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let s;
    // 外部定时器兜底：socket 卡在 TCP 连接阶段时 s.setTimeout 不会触发，会让顶层 await 永远不 settle（exit 13）
    const 兜底 = setTimeout(() => fin({ ok: false, error: 'timeout' }), timeout + 500);
    const fin = (r) => {
      if (done) return;
      done = true;
      clearTimeout(兜底);
      try { s && s.destroy(); } catch { }
      resolve(r);
    };
    try {
      s = tls.connect({ host, port, servername: servername || host, rejectUnauthorized: false });
    } catch (e) {
      fin({ ok: false, error: String(e.code || e.message).slice(0, 40) });
      return;
    }
    s.once('secureConnect', () => {
      const c = s.getPeerCertificate() || {};
      fin({ ok: true, ms: Date.now() - t0, cn: c.subject?.CN || null, issuer: c.issuer?.CN || null, validTo: c.valid_to || null });
    });
    s.once('error', (e) => fin({ ok: false, error: String(e.code || e.message).slice(0, 40) }));
  });
}

// ---------- WS 路径探测（1 个 RTT）：400/426/101 = 路径存在；404 = 路径漂移 ----------
async function probeWsPath(p, timeout = 4000) {
  try {
  const http = await import('node:http');
  const https = await import('node:https');
  // 路径里可能有中文/空格，node 的 http.request 要求 ASCII，否则抛 ERR_UNESCAPED_CHARACTERS
  const 路径 = String((p['ws-opts'] && p['ws-opts'].path) || '/').replace(/[^\x21-\x7E]/g, (c) => encodeURIComponent(c));
  const 头Host = (p['ws-opts'] && p['ws-opts'].headers && p['ws-opts'].headers.Host) || p.server;
  const mod = p.tls ? https : http;
  const opt = {
    host: p.server, port: p.port, path: 路径, method: 'GET', timeout,
    headers: {
      Host: 头Host, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  };
  if (p.tls) { opt.rejectUnauthorized = false; if (p.servername) opt.servername = p.servername; }
  return new Promise((resolve) => {
    let done = false;
    let req;
    // 同样要外部定时器：连接卡住时 req 的 timeout 事件不一定触发
    const 兜底 = setTimeout(() => 结束({ status: 0, ok: false, error: 'timeout' }), timeout + 500);
    const 结束 = (r) => {
      if (done) return;
      done = true;
      clearTimeout(兜底);
      try { req && req.destroy(); } catch { }
      resolve(r);
    };
    try {
      req = mod.request(opt, (res) => {
        const 码 = res.statusCode;
        res.resume();
        // 101 升级成功 / 400 握手被拒 / 426 需要升级 —— 都说明这个路径上确实有 ws 服务
        结束({ status: 码, ok: 码 === 101 || 码 === 400 || 码 === 426 });
      });
      req.on('error', (e) => 结束({ status: 0, ok: false, error: String(e.code || e.message).slice(0, 30) }));
      req.end();
    } catch (e) {
      结束({ status: 0, ok: false, error: String(e.code || e.message).slice(0, 30) });
    }
  });
  } catch (e) { return { status: 0, ok: false, error: String(e.code || e.message).slice(0, 30) }; }
}

// ---------- 协议层廉价预筛：TLS → WS 路径 ----------
const 协议统计 = { tls检查: 0, tls失败: 0, ws检查: 0, ws路径错: 0 };
if (process.env.PROTO_PROBE !== '0') {
  const t0 = Date.now();
  const 并发 = 80;
  // TLS：只测 tls 节点
  const tls节点 = alive.filter((p) => p.tls);
  协议统计.tls检查 = tls节点.length;
  let i = 0;
  await Promise.all(Array.from({ length: 并发 }, async () => {
    while (i < tls节点.length) {
      const p = tls节点[i++];
      const r = await probeTls(p.server, p.port, p.servername || (p['ws-opts'] && p['ws-opts'].headers && p['ws-opts'].headers.Host));
      if (!r.ok) { 协议统计.tls失败++; p.__tlsFail = r.error; }
      else p.__certIssuer = r.issuer;
    }
  }));

  // WS：只测 ws 节点（TLS 已失败的跳过）
  const ws节点 = alive.filter((p) => p.network === 'ws' && !p.__tlsFail);
  协议统计.ws检查 = ws节点.length;
  i = 0;
  await Promise.all(Array.from({ length: 并发 }, async () => {
    while (i < ws节点.length) {
      const p = ws节点[i++];
      const r = await probeWsPath(p);
      // 只放行 101(升级成功)/400(握手被拒但路径存在)/426(需要升级)。
      // 之前只把 404 当失败，实测墙内 45 个 ws 失败里 42 个是 403/530/500/521/ECONNRESET 这类
      // 服务端明确拒绝 —— CI 完全能测出来，不该放过。status===0 是网络层错误（可能视角相关），保留。
      if (!r.ok && r.status > 0) { 协议统计.ws路径错++; p.__wsPathBad = true; }
    }
  }));

  const 前 = alive.length;
  alive = alive.filter((p) => !p.__tlsFail && !p.__wsPathBad);
  console.log(`[协议预筛] TLS ${协议统计.tls检查} 个（握手失败 ${协议统计.tls失败}）｜WS ${协议统计.ws检查} 个（路径 404 ${协议统计.ws路径错}）→ 剔除 ${前 - alive.length} 个（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
}

// 清掉探测用的内部字段，别写进产物
for (const p of alive) { for (const k of Object.keys(p)) if (k.startsWith("__")) delete p[k]; }

// ---------- 国内可达性剔除（数据来自独立的 cn-probe 工作流）----------
// 只剔「国内探针明确判不可达」的 host:port；数据缺失/过期就不做这层，避免用陈旧结论误杀。
let CN不可达 = new Set();
const CN结果 = new Map();
let CN信息 = null;
try {
  const cn = JSON.parse(fs.readFileSync(new URL('../dist/cn-probe.json', import.meta.url), 'utf8'));
  const 年龄h = (Date.now() - Date.parse(cn.generatedAt || 0)) / 3600e3;
  if (年龄h <= Number(process.env.CN_MAX_AGE_HOURS || 36)) {
    for (const [hp, v] of Object.entries(cn.results || {})) { if (!v) continue; CN结果.set(hp, v); if (v.ok === false) CN不可达.add(hp); }
    CN信息 = { vantage: cn.vantage, ageHours: Number(年龄h.toFixed(1)), covered: Object.keys(cn.results || {}).length, unreachable: CN不可达.size };
  } else {
    console.log(`[CN] 探测数据过旧（${年龄h.toFixed(1)}h），本轮跳过国内剔除`);
  }
} catch {
  console.log('[CN] 没有 dist/cn-probe.json，本轮跳过国内剔除');
}
if (CN不可达.size) {
  const 前 = alive.length;
  alive = alive.filter((p) => !CN不可达.has(`${p.server}:${p.port}`));
  console.log(`[CN] 剔除国内不可达 ${前 - alive.length} 个（覆盖 ${CN信息.covered} 个 host:port，数据 ${CN信息.ageHours}h 前，视角 ${CN信息.vantage}）`);
}

// ---------- 实测质量排序 ----------
// 两个信号：① speed.json 里的实测下载 MB/s（抽样，样本少但最准）；② 探活 RTT（全覆盖）。
// 排序规则：有 MB/s 的按快的在前；没有的按 RTT 升序。精简池按这个顺序取，等于「优先给快的」。
const SPEED = new Map();
try {
  const sp = JSON.parse(fs.readFileSync(new URL('../dist/speed.json', import.meta.url), 'utf8'));
  for (const r of sp.results || []) if (r.ok && r.mbps > 0) { if (r.server && r.port) SPEED.set(r.server + ':' + r.port, r.mbps); else SPEED.set(String(r.node), r.mbps); }
  console.log(`[速度] 载入 ${SPEED.size} 个实测样本`);
} catch { }
const 质量键 = (p) => {
  const hp = p.server + ':' + p.port;
  const cn = CN结果.get(hp);
  const mb = SPEED.get(hp) ?? SPEED.get(String(p.name)) ?? -1;
  const rtt = RTT.get(hp) ?? 99999;
  // 分级：国内已验证可达(0) → 未被国内探测(1) → 不可达(2，后面会被剔掉)
  const tier = cn ? (cn.ok ? 0 : 2) : 1;
  // 主指标：国内实测 RTT 最快优先；没有就用 CI 侧 MB/s 折算；再没有用 TCP RTT
  const 主 = cn && cn.ok && cn.ms ? cn.ms : (mb > 0 ? Math.round(1000 / mb) : rtt);
  return { tier, 主 };
};
alive.sort((a, b) => {
  const x = 质量键(a), y = 质量键(b);
  if (x.tier !== y.tier) return x.tier - y.tier;
  return x.主 - y.主;
});
const 有速度 = alive.filter((p) => SPEED.has(p.server + ':' + p.port) || SPEED.has(String(p.name))).length;
console.log(`[排序] ${alive.length} 个节点按「实测速度优先 → RTT 升序」排好（其中 ${有速度} 个有 MB/s 实测）`);

// ---------- 字段净化 ----------
// 源里偶发带控制字符（含 C1 区 \u0080-\u009F）或未配对代理项：
// js-yaml 会把 C1 转义成 \xNN，而 go-yaml 不支持 \x 转义 → 内核报 invalid Unicode character escape code。
const 清洗字段 = (v) => {
  if (typeof v === 'string') {
    return v
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
      .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  }
  if (Array.isArray(v)) return v.map(清洗字段);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, 清洗字段(x)]));
  return v;
};
alive = alive.map((p) => 清洗字段(p));

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

// 池订阅也用同一套规则（规则真源见 scripts/rules.mjs）
groups.push(...别名分组);
const { rules: 规则, 来源: 规则来源 } = await buildRules();

const out = {
  'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'warning',
  'unified-delay': true, 'tcp-concurrent': true,
  proxies: alive, 'proxy-groups': groups, rules: 规则,
};

// ---------- 精简池 ----------
// 客户端一次性对所有节点做健康检查会大面积超时（实测：23 个 1.3s 通过，918 个 8s 仍超时），
// 所以另出一份按地区分层的精简池给订阅使用；全量池仍保留在 clash.yaml。
//
// 关键口径：精简池只收「国内探针确认可达」的节点。
// 之前的版本按 tier 排序但仍把「从未被国内探测」的节点放了进来，实测 396 个里 254 个（64%）
// 从未测过 → 客户端里大面积 Error（从美国 TCP 通 ≠ 国内能用）。
const LITE_PER_REGION = 80;
const LITE_MAX = 900;
const 按名索引 = new Map(alive.map((p) => [p.name, p]));
const 国内确认 = (name) => {
  const p = 按名索引.get(name);
  if (!p) return false;
  const c = CN结果.get(`${p.server}:${p.port}`);
  return !!c && c.ok === true;
};
// 不安全节点不进精简池：skip-cert-verify / allowInsecure / insecure = 接受任意证书，
// 链路上任何人都能冒充目标站点（中间人）。个人订阅按用户要求一律不收。
const 是不安全 = (p) => p['skip-cert-verify'] === true || p.allowInsecure === true || p.insecure === true;
const 不安全名 = new Set(alive.filter(是不安全).map((p) => p.name));
const 安全过滤 = (name) => !不安全名.has(name);
const 候选过滤 = (name) => 国内确认(name) && 安全过滤(name);
const liteNames = new Set();
const 候选地区 = Object.values(byRegion).map((names) => names.filter(候选过滤));
const 国内确认总数 = 候选地区.reduce((a, l) => a + l.length, 0);
// 兜底：可用数据太少时退回原逻辑，避免订阅变空
const 用国内确认 = 国内确认总数 >= 20;
if (用国内确认) {
  for (const names of 候选地区) {
    if (liteNames.size >= LITE_MAX) break;
    for (const n of names.slice(0, LITE_PER_REGION)) {
      if (liteNames.size >= LITE_MAX) break;
      liteNames.add(n);
    }
  }
  console.log(`[精简池] 收 ${liteNames.size} 个（国内 TCP 可达候选 ${国内确认总数}，已剔除不安全 ${不安全名.size}）`);
} else {
  for (const names of Object.values(byRegion)) {
    if (liteNames.size >= LITE_MAX) break;
    for (const n of names.filter(安全过滤).slice(0, LITE_PER_REGION)) {
      if (liteNames.size >= LITE_MAX) break;
      liteNames.add(n);
    }
  }
  console.log(`[精简池] 候选不足（${国内确认总数}），退回未筛选口径：${liteNames.size} 个（已剔除不安全 ${不安全名.size}）`);
}
const liteAlive = alive.filter((p) => liteNames.has(p.name) && !是不安全(p));
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
  proxies: liteAlive, 'proxy-groups': liteGroups.concat(别名分组), rules: 规则,
};

const summary = {
  generatedAt: new Date().toISOString(),
  totalRaw: collected.length,
  totalUnique: unique.length,
  totalAlive: alive.length,
  probe: probeInfo,
  protocolProbe: 协议统计,
  regions: Object.fromEntries(Object.entries(byRegion).map(([k, v]) => [k, v.length])),
  byType: alive.reduce((a, p) => ((a[p.type] = (a[p.type] || 0) + 1), a), {}),
  unsafe: { total: 不安全名.size, cnConfirmed: [...不安全名].filter((n) => 国内确认(n)).length },
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
  const 全量YAML = yaml.dump(out, { lineWidth: 4096, noRefs: true });
  const 精简YAML = yaml.dump(outLite, { lineWidth: 4096, noRefs: true });
  // 落盘前最后一道：整份文本再断言一次私有标记，命中直接失败（线上保持上一版）
  for (const [名, 文] of [['clash.yaml', 全量YAML], ['clash-lite.yaml', 精简YAML]]) {
    if (私有凭据.test(文)) throw new Error(`[GUARD] ${名} 命中私有标记，拒绝发布`);
  }
  fs.writeFileSync(new URL('clash.yaml', distDir), 全量YAML);
  fs.writeFileSync(new URL('clash-lite.yaml', distDir), 精简YAML);
  console.log(`发布 ${alive.length} 节点，地区组 ${Object.keys(byRegion).length} 个；精简池 ${liteAlive.length} 节点`);
}
console.log(JSON.stringify({ ...summary, sources: undefined }, null, 2));
