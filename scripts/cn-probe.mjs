#!/usr/bin/env node
// 国内视角可达性探测：在一台「墙内直连」的机器上跑（无 TUN、无代理），
// 对每个节点的 server:port 做 TCP 三次握手 —— 这正是「国内客户端能不能连上它」。
//
// 用法（在墙内机器上）：
//   node cn-probe.mjs --input=targets.json --out=cn-probe.json [--budget=800] [--timeout=3000] [--concurrency=60]
//
// 输入 targets.json: [{ "host": "1.2.3.4", "port": 443, "name": "节点名" }]
// 输出 cn-probe.json: { generatedAt, vantage, total, ok, results: { "host:port": { ok, ms } } }
import fs from 'node:fs';
import net from 'node:net';

const 参数 = new Map(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));

const 输入 = 参数.get('input') || 'targets.json';
const 输出 = 参数.get('out') || 'cn-probe.json';
const 预算 = Number(参数.get('budget') || 800);
const 超时 = Number(参数.get('timeout') || 3000);
const 并发 = Number(参数.get('concurrency') || 60);
const 视角 = 参数.get('vantage') || 'cn';

const 目标 = JSON.parse(fs.readFileSync(输入, 'utf8'));

// 按 host:port 去重：同一台服务器上挂多个节点只测一次，省时间也省得误判
const 唯一 = new Map();
for (const t of 目标) {
  if (!t || !t.host || !t.port) continue;
  const k = `${t.host}:${t.port}`;
  if (!唯一.has(k)) 唯一.set(k, { host: t.host, port: Number(t.port), name: t.name || '' });
}
const 列表 = [...唯一.values()].slice(0, 预算);
console.log(`[cn-probe] 目标 ${目标.length} 个 → 去重 ${唯一.size} 个 → 本轮测 ${列表.length} 个（超时 ${超时}ms 并发 ${并发}）`);

const 探一个 = ({ host, port }) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    let 完 = false;
    const 结束 = (ok) => {
      if (完) return;
      完 = true;
      try { s.destroy(); } catch { }
      resolve({ ok, ms: Date.now() - t0 });
    };
    s.setTimeout(超时, () => 结束(false));
    s.on('connect', () => 结束(true));
    s.on('error', () => 结束(false));
  });

const 结果 = {};
let i = 0, 成功 = 0;
await Promise.all(Array.from({ length: 并发 }, async () => {
  while (i < 列表.length) {
    const 项 = 列表[i++];
    const r = await 探一个(项);
    if (r.ok) 成功++;
    结果[`${项.host}:${项.port}`] = r;
  }
}));

const 报告 = {
  generatedAt: new Date().toISOString(),
  vantage: 视角,
  total: 列表.length,
  ok: 成功,
  okRate: Number(((成功 / Math.max(1, 列表.length)) * 100).toFixed(1)),
  results: 结果,
};
fs.writeFileSync(输出, JSON.stringify(报告, null, 0) + '\n');
console.log(`[cn-probe] 可达 ${成功}/${列表.length} = ${报告.okRate}% → ${输出}`);
