#!/usr/bin/env node
// 墙内真实可用性探测：在 CN 机器上跑（无 TUN、无代理）。
// 对每个节点做三层：TCP 连通 → (TLS 握手) → WS upgrade（带正确的 Host/路径）。
// 只有三层都过，才算「国内真能用」。输出 JSON，供上游筛选。
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

const 目标 = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/cn-targets.json', 'utf8'));
const 并发 = Number(process.env.CONC || 24);
const 超时 = Number(process.env.TMO || 6000);
const 输出 = process.argv[3] || '/tmp/cn-usable.json';

const TCP = (host, port) => new Promise((res) => {
  const t0 = Date.now();
  const s = net.connect({ host, port });
  let done = false;
  const fin = (ok) => { if (done) return; done = true; try { s.destroy(); } catch { } res({ ok, ms: Date.now() - t0 }); };
  s.setTimeout(超时, () => fin(false));
  s.on('connect', () => fin(true));
  s.on('error', () => fin(false));
});

const TLS握手 = (host, port, sni) => new Promise((res) => {
  let s;
  let done = false;
  const 计时 = setTimeout(() => fin(false), 超时 + 500);
  const fin = (ok) => { if (done) return; done = true; clearTimeout(计时); try { s && s.destroy(); } catch { } res(ok); };
  try { s = tls.connect({ host, port, servername: sni || host, rejectUnauthorized: false }); } catch { return fin(false); }
  s.once('secureConnect', () => fin(true));
  s.once('error', () => fin(false));
});

const WS升级 = (n) => new Promise((res) => {
  const 路径 = String(n.path || '/').replace(/[^\x21-\x7E]/g, (c) => encodeURIComponent(c));
  const mod = n.tls ? https : http;
  const opt = {
    host: n.server, port: n.port, path: 路径, method: 'GET', timeout: 超时,
    headers: { Host: n.host || n.server, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
  };
  if (n.tls) { opt.rejectUnauthorized = false; if (n.sni) opt.servername = n.sni; }
  let req;
  let done = false;
  const 计时 = setTimeout(() => fin({ status: 0, err: 'timeout' }), 超时 + 500);
  const fin = (r) => { if (done) return; done = true; clearTimeout(计时); try { req && req.destroy(); } catch { } res(r); };
  try {
    req = mod.request(opt, (r) => { r.resume(); fin({ status: r.statusCode }); });
    req.on('error', (e) => fin({ status: 0, err: String(e.code || e.message).slice(0, 24) }));
    req.end();
  } catch (e) { fin({ status: 0, err: String(e.code || e.message).slice(0, 24) }); }
});

const 测一个 = async (n) => {
  const tcp = await TCP(n.server, n.port);
  if (!tcp.ok) return { ...n, 结果: 'tcp_fail', ms: tcp.ms };
  if (n.tls) {
    const t = await TLS握手(n.server, n.port, n.sni);
    if (!t) return { ...n, 结果: 'tls_fail', ms: tcp.ms };
  }
  if (n.network === 'ws') {
    const w = await WS升级(n);
    const ok = [101, 400, 426].includes(w.status);
    return { ...n, 结果: ok ? 'ok' : 'ws_fail', ws: w.status, err: w.err, ms: tcp.ms };
  }
  return { ...n, 结果: 'ok', ms: tcp.ms };
};

const 结果 = [];
let i = 0;
await Promise.all(Array.from({ length: 并发 }, async () => {
  while (i < 目标.length) {
    const n = 目标[i++];
    try { 结果.push(await 测一个(n)); }
    catch (e) { 结果.push({ ...n, 结果: '异常', err: String(e.message || e).slice(0, 40) }); }
  }
}));

const 统计 = {};
for (const r of 结果) 统计[r.结果] = (统计[r.结果] || 0) + 1;
fs.writeFileSync(输出, JSON.stringify({ generatedAt: new Date().toISOString(), total: 结果.length, 统计, results: 结果 }, null, 1));
console.log('墙内实测', 结果.length, '个 →', JSON.stringify(统计));
const 可用 = 结果.filter((r) => r.结果 === 'ok').map((r) => r.name);
fs.writeFileSync(输出.replace('.json', '-ok.txt'), 可用.join('\n') + '\n');
console.log('可用', 可用.length, '个，已写', 输出.replace('.json', '-ok.txt'));
