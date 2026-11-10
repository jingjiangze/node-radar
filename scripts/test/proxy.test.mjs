// 解析与合法性校验的单测（node:test，无网络、无文件副作用）
// 这些函数决定「哪些节点能进公开产物」——写错一个条件，线上订阅就会整份加载失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  b64d, parseUri, invalid, dedupeKey, okReality, 缺字段, 配置合法, 允许类型,
} from '../lib/proxy.mjs';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const PBK = 'A'.repeat(43); // 合法：43 位 base64url

test('b64d 支持 url-safe 变体', () => {
  const raw = JSON.stringify({ add: 'a.example', port: '443', id: 'x' });
  const std = b64(raw);
  const urlsafe = std.replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(b64d(urlsafe), raw);
});

test('vmess：正常解析并映射 ws/tls', () => {
  const j = { v: '2', ps: '节点A', add: 'a.example', port: '443', id: 'uuid-1', aid: '0', net: 'ws', host: 'a.example', path: '/ray', tls: 'tls', sni: 'a.example' };
  const p = parseUri('vmess://' + b64(JSON.stringify(j)));
  assert.equal(p.type, 'vmess');
  assert.equal(p.server, 'a.example');
  assert.equal(p.port, 443);
  assert.equal(p.uuid, 'uuid-1');
  assert.equal(p.tls, true);
  assert.equal(p.servername, 'a.example');
  assert.equal(p.network, 'ws');
  assert.equal(p['ws-opts'].path, '/ray');
  assert.equal(p['ws-opts'].headers.Host, 'a.example');
  assert.equal(p.udp, true);
});

test('vmess：缺 add/port/id 一律丢弃', () => {
  for (const bad of [{ port: '443', id: 'x' }, { add: 'a.example', id: 'x' }, { add: 'a.example', port: '443' }]) {
    assert.equal(parseUri('vmess://' + b64(JSON.stringify(bad))), null);
  }
  assert.equal(parseUri('vmess://' + '!!!not-base64!!!'), null);
});

test('vless：reality 缺 pbk 直接丢弃（内核会拒绝整份配置）', () => {
  const url = 'vless://uuid@b.example:443?security=reality&sni=b.example';
  assert.equal(parseUri(url), null);
});

test('vless：reality 正常解析出 reality-opts', () => {
  const url = `vless://uuid@b.example:443?security=reality&sni=b.example&pbk=${PBK}&sid=abcd&fp=chrome`;
  const p = parseUri(url);
  assert.equal(p.type, 'vless');
  assert.equal(p.tls, true);
  assert.equal(p['reality-opts']['public-key'], PBK);
  assert.equal(p['reality-opts']['short-id'], 'abcd');
  assert.equal(p['client-fingerprint'], 'chrome');
});

test('okReality：公钥长度不对 / short-id 非 hex 判非法', () => {
  assert.equal(okReality({}), true);
  assert.equal(okReality({ 'reality-opts': { 'public-key': 'short' } }), false);
  assert.equal(okReality({ 'reality-opts': { 'public-key': PBK, 'short-id': 'zzzz' } }), false);
  assert.equal(okReality({ 'reality-opts': { 'public-key': PBK, 'short-id': 'ab12' } }), true);
});

test('ss：userinfo 为独立 base64 的写法', () => {
  const p = parseUri('ss://' + b64('aes-128-gcm:pw') + '@c.example:8388#name');
  assert.equal(p.type, 'ss');
  assert.equal(p.server, 'c.example');
  assert.equal(p.port, 8388);
  assert.equal(p.cipher, 'aes-128-gcm');
  assert.equal(p.password, 'pw');
  assert.equal(p.name, 'name');
});

test('ss：整段 base64 的写法', () => {
  const p = parseUri('ss://' + b64('chacha20-ietf-poly1305:pw2@d.example:443'));
  assert.equal(p.server, 'd.example');
  assert.equal(p.port, 443);
  assert.equal(p.cipher, 'chacha20-ietf-poly1305');
  assert.equal(p.password, 'pw2');
});

test('trojan：解析密码与 sni / skip-cert-verify', () => {
  const p = parseUri('trojan://tpw@e.example:443?sni=e.example&allowInsecure=1');
  assert.equal(p.type, 'trojan');
  assert.equal(p.password, 'tpw');
  assert.equal(p.sni, 'e.example');
  assert.equal(p['skip-cert-verify'], true);
});

test('hysteria2：URI 缺 obfs-password 时直接不写 obfs（安全降级），YAML 来源的缺 password 才判非法', () => {
  // URI 路径：只有 obfs 和 password 同时存在才落 obfs，否则静默丢弃 obfs 字段
  const 缺 = parseUri('hysteria2://pw@f.example:443?sni=f.example&obfs=salamander');
  assert.equal(缺.type, 'hysteria2');
  assert.equal(缺.obfs, undefined);
  assert.equal(invalid(缺), false);

  const 全 = parseUri('hysteria2://pw@f.example:443?sni=f.example&obfs=salamander&obfs-password=xyz');
  assert.equal(全.obfs, 'salamander');
  assert.equal(全['obfs-password'], 'xyz');
  assert.equal(invalid(全), false);

  // YAML 路径（aggregate 直接吃 clash 源）：obfs 有值但缺 obfs-password → 内核拒绝加载整份配置
  assert.equal(invalid({ type: 'hysteria2', server: 'f.example', port: 443, password: 'pw', obfs: 'salamander' }), true);
});

test('缺字段：ss 无 cipher / vless 无 uuid', () => {
  assert.equal(缺字段({ type: 'ss', password: 'p' }), 'cipher');
  assert.equal(缺字段({ type: 'vless', uuid: '  ' }), 'uuid');
  assert.equal(缺字段({ type: 'vmess', uuid: 'u' }), null);
});

test('配置合法：控制字符 / 空白 / 坏的 % 转义全部拦截', () => {
  assert.equal(配置合法({ 'ws-opts': { headers: { Host: 'a\u0001.example' } } }), false);
  assert.equal(配置合法({ servername: 'a b.example' }), false);
  assert.equal(配置合法({ 'ws-opts': { path: '/x%zz' } }), false);
  assert.equal(配置合法({ 'ws-opts': { path: '/x%20y' } }), true);
  assert.equal(配置合法({}), true);
});

test('invalid：缺 type 的必填表不误伤其它协议', () => {
  assert.equal(invalid({ type: 'hysteria', 'auth-str': 'x' }), false);
  assert.equal(invalid({ type: 'hysteria' }), true);
});

test('dedupeKey：同服务器同端口同身份视为重复，换身份/端口不算', () => {
  const a = { type: 'vless', server: 'g.example', port: 443, uuid: 'u1' };
  assert.equal(dedupeKey(a), dedupeKey({ ...a }));
  assert.notEqual(dedupeKey(a), dedupeKey({ ...a, port: 8443 }));
  assert.notEqual(dedupeKey(a), dedupeKey({ ...a, uuid: 'u2' }));
  // 大小写不敏感
  assert.equal(dedupeKey({ ...a, server: 'G.EXAMPLE' }), dedupeKey(a));
});

test("允许类型：内核不认的协议在入库前就剔掉（否则整份配置加载失败）", () => {
  assert.equal(invalid({ type: "masque", server: "a.example", port: 443 }), true);
  assert.equal(invalid({ type: "", server: "a.example", port: 443 }), true);
  assert.equal(invalid({ server: "a.example", port: 443 }), true);
  for (const type of ["vmess", "vless", "trojan", "ss", "hysteria2", "http", "socks5", "mieru"]) {
    assert.equal(允许类型.has(type), true, type);
  }
});
