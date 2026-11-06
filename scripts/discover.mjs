#!/usr/bin/env node
// 自动发现新的公开节点源：GitHub 搜索 → 列仓库根目录找订阅文件 → 校验能解析出节点 → 写入 sources.auto.json
// 只收「公开可见、能直接下载、内容可解析」的源；宁缺毋滥。

import fs from 'node:fs';

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const OUT = new URL('../sources.auto.json', import.meta.url);\nconst CANDIDATES = new URL('../sources.candidates.json', import.meta.url);
const MIN_NODES = 5;
const MAX_REPOS = 30;
const MAX_FILES = 3;
const TIMEOUT_MS = 15000;

const QUERIES = [
  '免费节点 订阅',
  'vless 订阅 免费',
  'clash 订阅 自动更新',
  'free vless subscription',
  'clash subscription free nodes',
];

// 文件名里带这些词就当成候选
const NAME_HINT = /(^|[._-])(sub|subs|subscribe|subscription|clash|list|nodes?|v2ray|proxies|provider)([._-]|$)/i;
const EXT_OK = /\.(yaml|yml|txt)$/i;

const UA = 'node-radar/discover (+https://github.com/jingjiangze/node-radar)';

const loadJson = (url, fallback) => { try { return JSON.parse(fs.readFileSync(url, 'utf8')); } catch { return fallback; } };

async function ghJson(path) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
  });
  if (!r.ok) throw new Error(`GH ${r.status}`);
  return r.json();
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const txt = await r.text();
    return txt.length > 100 * 1024 * 1024 ? null : txt;   // 超大文件丢弃
  } catch { return null; } finally { clearTimeout(t); }
}

// 统计能识别出的节点数：Clash YAML 数「带 name 的列表项」；URI 列表数协议前缀
function countNodes(text) {
  if (!text || text.length < 200) return 0;
  const yamlItems = (text.match(/^\s*-\s*\{?\s*name\s*:/gm) || []).length;
  if (yamlItems > 0) return yamlItems;

  let t2 = text.trim();
  if (!/^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//m.test(t2)) {
    try { t2 = Buffer.from(t2.replace(/[-_]/g, (c) => (c === '-' ? '+' : '/')), 'base64').toString('utf8'); } catch { return 0; }
  }
  return (t2.match(/^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//gm) || []).length;
}

// ---------- 1. 搜索候选仓库 ----------
const repos = new Map();
for (const q of QUERIES) {
  try {
    const res = await ghJson(`/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=15`);
    for (const it of res.items || []) {
      if (it.fork) continue;
      if (Date.now() - new Date(it.pushed_at).getTime() > 30 * 86400000) continue;
      repos.set(it.full_name, { full: it.full_name, stars: it.stargazers_count, branch: it.default_branch || 'main' });
    }
  } catch (e) { console.error('search failed:', q, e.message); }
}

const candidates = [...repos.values()].sort((a, b) => b.stars - a.stars).slice(0, MAX_REPOS);
console.log(`候选仓库 ${repos.size} 个，取前 ${candidates.length} 个验证`);

// ---------- 2. 列目录 → 选文件 → 校验 ----------
const existing = loadJson(OUT, []);
const curated = loadJson(new URL('../sources.json', import.meta.url), []);
const knownUrls = new Set([...existing, ...curated].map((s) => s.url));

const found = [];
for (const repo of candidates) {
  let items;
  try { items = await ghJson(`/repos/${repo.full}/contents/`); } catch { continue; }
  if (!Array.isArray(items)) continue;

  const files = items
    .filter((f) => f.type === 'file' && EXT_OK.test(f.name) && (NAME_HINT.test(f.name.replace(EXT_OK, '')) || /clash|sub|node/i.test(f.name)))
    .slice(0, MAX_FILES);

  for (const f of files) {
    let hit = null;
    for (const br of [...new Set([repo.branch, 'main', 'master'])].filter(Boolean)) {
      const url = `https://raw.githubusercontent.com/${repo.full}/${br}/${f.path}`;
      if (knownUrls.has(url)) { hit = { url, n: -1 }; break; }
      const n = countNodes(await fetchText(url));
      if (n >= MIN_NODES) { hit = { url, n }; break; }
    }
    if (hit && hit.n > 0) {
      found.push({ name: repo.full, url: hit.url, nodes: hit.n, verifiedAt: new Date().toISOString() });
      knownUrls.add(hit.url);
      console.log(`✓ ${repo.full}/${f.path} → ${hit.n} 节点`);
      break;
    }
  }
}

// ---------- 3. 候选隔离：连续三轮成功且跨度至少 48 小时才晋升 ----------
const priorCandidates = loadJson(CANDIDATES, []);
const candidateByUrl = new Map(priorCandidates.map((s) => [s.url, s]));
const now = Date.now();
for (const item of found) {
  const old = candidateByUrl.get(item.url);
  candidateByUrl.set(item.url, {
    ...item,
    firstSeen: old?.firstSeen || new Date(now).toISOString(),
    lastSeen: new Date(now).toISOString(),
    successfulRuns: (old?.successfulRuns || 0) + 1,
    status: 'candidate'
  });
}
const cutoff = now - 90 * 86400000;
const candidates = [...candidateByUrl.values()].filter((s) => new Date(s.lastSeen || s.verifiedAt || 0).getTime() > cutoff);
const promoted = candidates.filter((s) =>
  s.successfulRuns >= 3 &&
  now - new Date(s.firstSeen).getTime() >= 48 * 3600000 &&
  s.nodes >= MIN_NODES
);
const byUrl = new Map(existing.map((s) => [s.url, s]));
for (const item of promoted) byUrl.set(item.url, {
  name: item.name, url: item.url, nodes: item.nodes,
  verifiedAt: item.lastSeen, promotedAt: item.firstSeen
});
const merged = [...byUrl.values()].filter((s) => new Date(s.verifiedAt || 0).getTime() > cutoff);
fs.writeFileSync(CANDIDATES, JSON.stringify(candidates, null, 2) + '\n');
fs.writeFileSync(OUT, JSON.stringify(merged, null, 2) + '\n');
console.log(`sources.auto.json 共 ${merged.length} 条；候选 ${candidates.length} 条；本轮晋升 ${promoted.length} 条`);
