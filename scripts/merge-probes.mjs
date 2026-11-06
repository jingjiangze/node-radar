#!/usr/bin/env node
// 合并分片探测结果：dist/cn-probe-*.json → dist/cn-probe.json
// 每个 CI 分片独立写自己的文件（避免并发写同一份冲突），这个脚本负责汇总并保留历史。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'dist');
const 主文件 = path.join(DIST, 'cn-probe.json');

const 合并 = {};
let 视角 = 'globalping-cn';
let 本轮数 = 0;

// 先读历史（保留之前测过的）
try {
  const 旧 = JSON.parse(fs.readFileSync(主文件, 'utf8'));
  Object.assign(合并, 旧.results || {});
  if (旧.vantage) 视角 = 旧.vantage;
} catch { }

// 再叠加本轮各分片
const 分片文件 = fs.readdirSync(DIST).filter((f) => /^cn-probe-\d+\.json$/.test(f));
for (const f of 分片文件) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIST, f), 'utf8'));
    for (const [hp, v] of Object.entries(j.results || {})) {
      合并[hp] = v;
      本轮数++;
    }
  } catch (e) {
    console.error(`跳过损坏的分片 ${f}: ${e.message}`);
  }
}

const 条数 = Object.keys(合并).length;
const 可达 = Object.values(合并).filter((x) => x.ok).length;
const 报告 = {
  generatedAt: new Date().toISOString(),
  vantage: 视角,
  scope: 'clash.yaml（全量）',
  total: 条数,
  ok: 可达,
  okRate: Number(((可达 / Math.max(1, 条数)) * 100).toFixed(1)),
  thisRound: { shards: 分片文件.length, merged: 本轮数 },
  results: 合并,
};
fs.writeFileSync(主文件, JSON.stringify(报告, null, 0) + '\n');
console.log(`合并 ${分片文件.length} 个分片（${本轮数} 条）→ 累计 ${条数} 条，可达 ${可达}（${报告.okRate}%）`);

// 清理分片文件，避免下次重复计入
for (const f of 分片文件) { try { fs.unlinkSync(path.join(DIST, f)); } catch { } }
