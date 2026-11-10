// 「能数出多少节点」的判定单测：这个数决定一个源能否晋级（minNodes=20 门槛）
import test from 'node:test';
import assert from 'node:assert/strict';
import { 估节点数 } from '../discovery/parse.mjs';

test('uri 列表：只数协议行', () => {
  const t = ['vmess://abc', 'vless://x', '不是节点', 'trojan://y'].join('\n');
  assert.equal(估节点数(t), 3);
});

test('clash yaml：缩进的列表项', () => {
  const t = ['proxies:', '  - name: a', '    type: vmess', '  - name: b', '    type: ss', 'proxy-groups:'].join('\n');
  assert.equal(估节点数(t), 2);
});

test('clash yaml：顶格列表项（合法 YAML，曾经被误判为 0）', () => {
  const t = ['proxies:', '- name: a', '  type: vmess', '- name: b', '  type: ss', 'rules:'].join('\n');
  assert.equal(估节点数(t), 2);
});

test('clash yaml：流式写法与空段', () => {
  assert.equal(估节点数(['proxies:', '  - {name: a, type: vmess}', '  - {name: b, type: ss}'].join('\n')), 2);
  assert.equal(估节点数(['proxies:', 'proxy-groups:'].join('\n')), 0);
});

test('base64 订阅', () => {
  const raw = 'vless://a\nvless://b\nss://c';
  assert.equal(估节点数(Buffer.from(raw).toString('base64')), 3);
});

test('clash yaml：type 在前、name 在下一行（freeclashnode 写法）', () => {
  const t = ['proxies:', '  - type: vless', '    name: 甲', '    server: a.example', '  - type: ss', '    name: 乙', 'rules:'].join('\n');
  assert.equal(估节点数(t), 2);
});
