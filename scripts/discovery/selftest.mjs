#!/usr/bin/env node
// 离线自测：安全判定 / 归一化 / 登记表状态机 / 节点计数
// 用法：node scripts/discovery/selftest.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { 是否私网地址, 校验目标 } from './safety.mjs';
import { 归一化, 内容键, 像订阅, 抽链接, 抽节点链接, 是噪声 } from './normalize.mjs';
import { 读登记表, 写登记表, 登记候选, 记录结果, 汇总 } from './registry.mjs';

let 通过 = 0;
const 测 = async (名, fn) => {
  try { await fn(); 通过++; console.log('  ok  ', 名); }
  catch (e) { console.error('  FAIL', 名, '→', e.message); process.exitCode = 1; }
};

console.log('— 私网判定 —');
await 测('拒绝回环/内网/元数据/CGNAT', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.ok(是否私网地址(ip), `${ip} 应判为私网`);
  }
});
await 测('放行正常公网地址', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '104.16.0.1', '2606:4700:4700::1111']) {
    assert.equal(是否私网地址(ip), null, `${ip} 不该被拦`);
  }
});
await 测('URL 校验拦本机与元数据地址', async () => {
  for (const u of ['http://127.0.0.1/sub', 'http://169.254.169.254/latest/meta-data', 'ftp://example.com/x']) {
    await assert.rejects(() => 校验目标(u), undefined, `${u} 应被拒`);
  }
});
await 测('URL 含凭据被拒', async () => {
  await assert.rejects(() => 校验目标('https://user:pass@example.com/sub'));
});

console.log('— 归一化 —');
await 测('去 fragment/默认端口/跟踪参数，保留 token', () => {
  assert.equal(归一化('HTTPS://Example.COM:443/a?b=1&utm_source=x#frag'), 'https://example.com/a?b=1');
  assert.equal(归一化('https://x.com/sub?token=abc&utm_medium=t'), 'https://x.com/sub?token=abc');
});
await 测('内容键忽略参数，识别镜像', () => {
  assert.equal(内容键('https://a.com/sub?token=1'), 内容键('https://a.com/sub?token=2'));
});
await 测('订阅特征', () => {
  assert.ok(像订阅('https://x.com/clash.yaml'));
  assert.ok(像订阅('https://x.com/api/v1/client/subscribe?token=abc'));
  assert.ok(!像订阅('https://x.com/about'));
});
await 测('噪声过滤不误伤订阅', () => {
  assert.ok(是噪声('https://github.com/x/y/issues'));
  assert.ok(!是噪声('https://x.com/sub?token=abc'));
});
await 测('抽链接/抽节点', () => {
  assert.equal(抽链接('a https://x.com/1 b https://y.com/2.').length, 2);
  assert.equal(抽节点链接('vless://a@b:1?x=1 vmess://zzz').length, 2);
});

console.log('— 登记表状态机 —');
await 测('三连挂 → rejected；已接受连挂 2 次 → 降级', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-')), 'c.json');
  const t = 读登记表(f);
  登记候选(t, { url: 'https://a/sub', channel: 'seed' });
  for (let i = 0; i < 3; i++) 记录结果(t, 'https://a/sub', { ok: false, reason: 'x' });
  assert.equal(t.items['https://a/sub'].status, 'rejected');

  登记候选(t, { url: 'https://b/sub', channel: 'seed' });
  记录结果(t, 'https://b/sub', { ok: true, nodes: 30 });
  assert.equal(t.items['https://b/sub'].status, 'accepted');
  记录结果(t, 'https://b/sub', { ok: false });
  assert.equal(t.items['https://b/sub'].status, 'accepted', '连挂 1 次还不该降级');
  记录结果(t, 'https://b/sub', { ok: false });
  assert.equal(t.items['https://b/sub'].status, 'candidate', '连挂 2 次应降回候选');

  写登记表(f, t);
  const 回读 = 读登记表(f);
  assert.equal(汇总(回读).rejected, 1);
});
await 测('v1 数组自动迁移', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reg2-')), 'c.json');
  fs.writeFileSync(f, JSON.stringify([{ name: 'x', url: 'https://a/sub', nodes: 12 }]));
  const t = 读登记表(f);
  assert.equal(t.version, 2);
  assert.equal(t.items['https://a/sub'].status, 'accepted');
});

console.log('— 节点计数 —');
await 测('三种格式都能数', async () => {
  const { 估节点数 } = await import('./parse.mjs');
  
  assert.equal(估节点数('vless://a\nvmess://b\n'), 2);
  assert.equal(估节点数('proxies:\n  - name: a\n  - {name: b}\n'), 2);
  assert.equal(估节点数(Buffer.from('vless://a\ntrojan://c').toString('base64')), 2);
});

console.log(`\n通过 ${通过} 项`);
