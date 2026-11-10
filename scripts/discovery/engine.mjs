#!/usr/bin/env node
// 发现引擎：调度六类适配器 → 归一化去重 → 抓取校验 → 登记表 → sources.auto.json
// 设计原则：预算优先、单点失败不拖垮整轮、候选与正式分离（只有过关的才进 sources.auto.json）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { 安全抓取 } from './safety.mjs';
import { 归一化, 内容键, 内容哈希, 像订阅 } from './normalize.mjs';
import { 读登记表, 写登记表, 登记候选, 记录结果, 汇总, 标记镜像 } from './registry.mjs';
import { 全部适配器 } from './adapters.mjs';
import { 估节点数 } from './parse.mjs';
import { 建夹具抓取 } from './fixtures.mjs';
import { 日期变体 } from '../lib/date-url.mjs';

const 目录 = path.dirname(fileURLToPath(import.meta.url));
const 根 = path.resolve(目录, '../..');

const 参数 = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const DRY = 参数.has('dry');
const ONLY = (参数.get('only') || '').split(',').filter(Boolean);
// --out 让测试写到临时目录，不碰仓库文件
const 输出目录 = 参数.get('out') ? path.resolve(参数.get('out')) : 根;
const AUTO = path.join(输出目录, 'sources.auto.json');
const REGISTRY = path.join(输出目录, 'sources.candidates.json');
const REPORT = path.join(输出目录, 'discovery-report.json');
// --fixture 走离线夹具：适配器/去重/校验/登记表全走真实代码，只有取数据这层被替换
const FIXTURE = 参数.get('fixture') ? path.resolve(参数.get('fixture')) : null;

const 配置 = JSON.parse(fs.readFileSync(path.join(目录, 'config.json'), 'utf8'));
const 上限 = { ...配置.limits, ...(参数.has('budget') ? { validatePerRun: Number(参数.get('budget')) } : {}) };
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const UA = 'node-radar/discovery (+https://github.com/jingjiangze/node-radar)';

const 计时 = () => new Date().toISOString().slice(11, 19);
const 日志 = (...a) => console.log(`[${计时()}]`, ...a);

async function gh真实(pathname) {
  const r = await fetch(`https://api.github.com${pathname}`, {
    headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`GH ${r.status}`);
  return r.json();
}

const 夹具 = FIXTURE ? 建夹具抓取(FIXTURE) : null;
const 抓取原生 = 夹具 ? 夹具.抓取 : (url, opt) => 安全抓取(url, opt);
// 动态日期源：今天取不到就退到昨天
const 抓取 = async (url, opt) => {
  let last;
  for (const u of 日期变体(url)) {
    try { return await 抓取原生(u, opt); } catch (err) { last = err; }
  }
  throw last;
};
const gh = 夹具 ? 夹具.gh : gh真实;


async function 并发映射(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const 工人 = Array.from({ length: Math.max(1, n) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(工人);
  return out;
}

const 主 = async () => {
  日志(`发现引擎启动 dry=${DRY} only=${ONLY.join(',') || '全部'} 预算=${上限.validatePerRun}`);

  const 注册 = 读登记表(REGISTRY);
  const ctx = {
    token: TOKEN, gh, 抓取, 日志, 上限,
    配置: { ...配置, ...(参数.has('channels') ? { telegramChannels: 参数.get('channels').split(',') } : {}) },
  };

  // 1) 跑适配器
  const 原始候选 = [];
  const 渠道统计 = {};
  for (const a of 全部适配器) {
    if (ONLY.length && !ONLY.includes(a.name)) continue;
    const t0 = Date.now();
    try {
      const 结果 = await a.run(ctx);
      渠道统计[a.name] = { 产出: 结果.length, 耗时ms: Date.now() - t0 };
      日志(`[${a.name}] 产出 ${结果.length} 个候选（${Date.now() - t0}ms）`);
      for (const x of 结果) 原始候选.push({ ...x, channel: a.name });
    } catch (e) {
      渠道统计[a.name] = { 产出: 0, 失败: String(e.message).slice(0, 120) };
      日志(`[${a.name}] 适配器失败: ${e.message}`);
    }
  }

  // 2) 归一化 + 去重（URL 与内容键双维度）
  const 去重表 = new Map();
  for (const c of 原始候选) {
    if (!像订阅(c.url)) continue;
    const u = 归一化(c.url);
    if (!u) continue;
    const k = u;
    if (!去重表.has(k)) 去重表.set(k, { url: u, channel: c.channel, note: c.note });
  }
  const 候选 = [...去重表.values()];
  日志(`去重后候选 ${候选.length} 个`);

  // 2b) 按渠道轮转排序：避免某个高噪声渠道（如盲猜文件名的仓库嗅探）把预算吃光
  const 渠道顺序 = ['seeds', 'recursive', 'github-code', 'github-search', 'telegram', 'feed', 'search'];
  const 分桶 = new Map();
  for (const c of 候选) {
    const k = c.channel || 'other';
    if (!分桶.has(k)) 分桶.set(k, []);
    分桶.get(k).push(c);
  }
  const 轮转 = [];
  let 还有 = true;
  while (还有) {
    还有 = false;
    for (const ch of 渠道顺序) {
      const 桶 = 分桶.get(ch);
      if (桶 && 桶.length) { 轮转.push(桶.shift()); 还有 = true; }
    }
  }
  for (const c of 候选) if (!轮转.includes(c)) 轮转.push(c);

  // 3) 校验（预算内）
  const 待验 = 轮转.slice(0, 上限.validatePerRun);
  const 已接受URL = new Set(
    (() => { try { return JSON.parse(fs.readFileSync(AUTO, 'utf8')).map((x) => 归一化(x.url)); } catch { return []; } })()
  );

  const 校验结果 = await 并发映射(待验, 上限.validateConcurrency, async (c) => {
    登记候选(注册, { url: c.url, channel: c.channel });
    try {
      const r = await 抓取(c.url, { maxBytes: 5 * 1024 * 1024, timeoutMs: 20000 });
      const n = 估节点数(r.body);
      const hash = 内容哈希(r.body);
      if (n < 配置.minNodes) {
        记录结果(注册, c.url, { ok: false, reason: `节点数 ${n} < ${配置.minNodes}` });
        return { ...c, ok: false, nodes: n, reason: `节点不足(${n})` };
      }
      记录结果(注册, c.url, { ok: true, nodes: n, contentHash: hash });
      return { ...c, ok: true, nodes: n, hash };
    } catch (e) {
      记录结果(注册, c.url, { ok: false, reason: String(e.message).slice(0, 120) });
      return { ...c, ok: false, nodes: 0, reason: String(e.message).slice(0, 120) };
    }
  });

  // 3b) 内容哈希去重：同一份订阅被多个项目转载时只留一条，其余标 mirror
  const 镜像数 = 标记镜像(注册, 待验.map((x) => x.url));
  if (镜像数) 日志(`识别镜像 ${镜像数} 个（内容相同，不重复入库）`);

  const 新增 = 校验结果.filter((x) => x.ok && 注册.items[x.url]?.status === 'accepted');
  日志(`本轮校验：通过 ${新增.length} / ${校验结果.length}`);

  // 4) 合并进 sources.auto.json（保留历史通过项）
  let 历史 = [];
  try { 历史 = JSON.parse(fs.readFileSync(AUTO, 'utf8')); } catch { }
  const 合并 = new Map(历史.map((x) => [归一化(x.url) || x.url, x]));
  for (const x of 新增) {
    合并.set(x.url, {
      name: (x.note || x.channel || 'auto').slice(0, 60),
      url: x.url,
      nodes: x.nodes,
      verifiedAt: new Date().toISOString(),
      channel: x.channel,
      score: 注册.items[x.url]?.score ?? 0,
    });
  }
  // 登记表里被判 rejected / mirror 的同步剔出正式清单
  for (const [u, item] of Object.entries(注册.items)) {
    if (item.status === 'rejected' || item.status === 'mirror') 合并.delete(u);
  }
  // 历史条目回填 score（老版本的 sources.auto.json 没有这个字段）
  for (const [u, x] of 合并) {
    const 项 = 注册.items[u];
    if (typeof x.score !== 'number') x.score = 项?.score ?? 0;
    if (项 && typeof x.nodes !== 'number') x.nodes = 项.nodes;
  }
  // 按信誉分排序（同分再看节点数）
  const 正式 = [...合并.values()].sort((a, b) => (b.score || 0) - (a.score || 0) || (b.nodes || 0) - (a.nodes || 0));
  日志(`正式源 ${正式.length} 个（本轮新增 ${新增.length}，镜像 ${镜像数}）`);

  const 报告 = {
    generatedAt: new Date().toISOString(),
    budget: 上限.validatePerRun,
    channels: 渠道统计,
    candidates: 待验.length,
    passed: 新增.length,
    registry: 汇总(注册),
    acceptedSources: 正式.length,
    newSources: 新增.slice(0, 30).map((x) => ({ url: x.url, nodes: x.nodes, channel: x.channel })),
    rejectedSample: 校验结果.filter((x) => !x.ok).slice(0, 30).map((x) => ({ url: x.url, reason: x.reason })),
  };

  if (DRY) {
    日志('dry 模式，不写文件');
    console.log(JSON.stringify(报告, null, 2).slice(0, 2000));
    return;
  }
  写登记表(REGISTRY, 注册);
  fs.writeFileSync(AUTO, JSON.stringify(正式, null, 2) + '\n');
  fs.writeFileSync(REPORT, JSON.stringify(报告, null, 2) + '\n');
  日志('已写入 sources.auto.json / sources.candidates.json / discovery-report.json');
};

主().catch((e) => {
  console.error('发现引擎异常：', e?.stack || e);
  process.exit(1);
});
