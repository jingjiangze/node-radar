#!/usr/bin/env node
// 测速后重排：把本轮的实测 MB/s 应用回已发布产物（同一轮内生效，不必等下一次聚合）。
// 排序规则与 aggregate 一致：国内实测 RTT 优先 → 实测 MB/s → 保持原相对顺序（稳定排序）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const DIST = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'dist');
const 读 = (f, 兜底) => { try { return JSON.parse(fs.readFileSync(path.join(DIST, f), 'utf8')); } catch { return 兜底; } };

const CN = new Map();
for (const [hp, v] of Object.entries(读('cn-probe.json', {}).results || {})) if (v) CN.set(hp, v);

const SPEED = new Map();
for (const r of 读('speed.json', {}).results || []) {
  if (r.ok && r.mbps > 0 && r.server && r.port) SPEED.set(`${r.server}:${r.port}`, r.mbps);
}

const 键 = (p) => {
  const hp = `${p.server}:${p.port}`;
  const cn = CN.get(hp);
  const mb = SPEED.get(hp) ?? -1;
  const tier = cn ? (cn.ok ? 0 : 2) : 1;
  const 主 = cn && cn.ok && cn.ms ? cn.ms : (mb > 0 ? Math.round(1000 / mb) : 99999);
  return { tier, 主 };
};

let 改了 = 0;
for (const f of ['clash.yaml', 'clash-lite.yaml']) {
  const 文件 = path.join(DIST, f);
  if (!fs.existsSync(文件)) continue;
  const doc = yaml.load(fs.readFileSync(文件, 'utf8'));
  if (!Array.isArray(doc.proxies)) continue;
  // 稳定排序：给每个节点带原索引，避免无数据节点被随机打乱
  const 带序 = doc.proxies.map((p, i) => ({ p, i, k: 键(p) }));
  带序.sort((a, b) => (a.k.tier - b.k.tier) || (a.k.主 - b.k.主) || (a.i - b.i));
  doc.proxies = 带序.map((x) => x.p);
  fs.writeFileSync(文件, yaml.dump(doc, { lineWidth: 4096, noRefs: true }));
  改了++;
  console.log(`[rerank] ${f}: ${doc.proxies.length} 个节点已按「国内 RTT → 实测 MB/s」重排`);
}
console.log(`[rerank] 完成，更新 ${改了} 个文件（速度样本 ${SPEED.size} 个，国内样本 ${CN.size} 个）`);
