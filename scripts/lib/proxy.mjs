// 订阅解析与合法性校验：从 aggregate.mjs 抽出，供单测直接调用（不进网络、不碰文件）。
//
// 为什么单独成模块：这些函数决定「哪些节点能进公开产物」，任何一条规则写错都会让线上订阅
// 整份加载失败（实测见过 proxy 3677: '' has unset fields: cipher）。以前它们埋在主脚本里，
// 只能靠 CI 实跑一轮才发现问题；抽出来后可以用 node:test 直接断言。

/** base64（含 url-safe）解码 */
export const b64d = (s) => Buffer.from(String(s).replace(/[-_]/g, (c) => (c === '-' ? '+' : '/')), 'base64').toString('utf8');

/** REALITY 公钥必须是 32 字节 base64url（43 字符），short-id 必须是 <=16 位 hex；否则内核拒绝加载整份配置 */
export const okReality = (p) => {
  const ro = p['reality-opts'];
  if (!ro) return true;
  const k = ro['public-key'];
  if (typeof k !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(k)) return false;
  const sid = ro['short-id'];
  if (sid !== undefined && sid !== null && !/^[0-9a-fA-F]{0,16}$/.test(String(sid))) return false;
  return true;
};

export function parseVless(u) {
  const url = new URL(u); const q = url.searchParams;
  const p = { name: decodeURIComponent(url.hash.slice(1)) || `vless-${url.hostname}`, type: 'vless', server: url.hostname, port: Number(url.port || 443), uuid: decodeURIComponent(url.username), udp: true };
  if (q.get('security') === 'tls' || q.get('security') === 'reality') {
    p.tls = true;
    if (q.get('sni')) p.servername = q.get('sni');
    if (q.get('fp')) p['client-fingerprint'] = q.get('fp');
    if (q.get('alpn')) p.alpn = q.get('alpn').split(',');
    if (q.get('allowInsecure') === '1') p['skip-cert-verify'] = true;
    if (q.get('security') === 'reality') {
      const pbk = q.get('pbk');
      if (!pbk || !/^[A-Za-z0-9_-]{43}$/.test(pbk)) return null;   // 缺 public-key 或格式非法
      p['reality-opts'] = { 'public-key': pbk };
      if (q.get('sid')) p['reality-opts']['short-id'] = q.get('sid');
    }
  }
  const net = q.get('type') || 'tcp';
  if (net === 'ws') { p.network = 'ws'; p['ws-opts'] = { path: q.get('path') || '/' }; if (q.get('host')) p['ws-opts'].headers = { Host: q.get('host') }; }
  else if (net === 'grpc') { p.network = 'grpc'; p['grpc-opts'] = { 'grpc-service-name': q.get('serviceName') || '' }; }
  else if (net === 'h2') { p.network = 'h2'; p['h2-opts'] = { path: q.get('path') || '/' }; if (q.get('host')) p['h2-opts'].host = [q.get('host')]; }
  return p;
}

export function parseTrojan(u) {
  const url = new URL(u); const q = url.searchParams;
  const p = { name: decodeURIComponent(url.hash.slice(1)) || `trojan-${url.hostname}`, type: 'trojan', server: url.hostname, port: Number(url.port || 443), password: decodeURIComponent(url.username), udp: true };
  if (q.get('sni')) p.sni = q.get('sni');
  if (q.get('allowInsecure') === '1') p['skip-cert-verify'] = true;
  if (q.get('type') === 'ws') { p.network = 'ws'; p['ws-opts'] = { path: q.get('path') || '/' }; if (q.get('host')) p['ws-opts'].headers = { Host: q.get('host') }; }
  return p;
}

export function parseSS(u) {
  const raw = u.slice(5).split('#')[0];
  const name = u.includes('#') ? decodeURIComponent(u.split('#').slice(1).join('#')) : null;
  let method, password, host, port;
  if (raw.includes('@')) { const [b64, hostport] = raw.split('@'); const dec = b64d(b64); [method, password] = dec.split(':'); [host, port] = hostport.split(':'); }
  else { const dec = b64d(raw); const at = dec.lastIndexOf('@'); if (at < 0) return null; [host, port] = dec.slice(at + 1).split(':'); const mp = dec.slice(0, at); const ci = mp.indexOf(':'); method = mp.slice(0, ci); password = mp.slice(ci + 1); }
  if (!host || !port || !method) return null;
  return { name: name || `ss-${host}`, type: 'ss', server: host, port: Number(port), cipher: method, password, udp: true };
}

export function parseHysteria2(u) {
  const url = new URL(u); const q = url.searchParams;
  const p = { name: decodeURIComponent(url.hash.slice(1)) || `hy2-${url.hostname}`, type: 'hysteria2', server: url.hostname, port: Number(url.port || 443), password: decodeURIComponent(url.username || '') };
  if (q.get('sni')) p.sni = q.get('sni');
  if (q.get('insecure') === '1') p['skip-cert-verify'] = true;
  const obfs = q.get('obfs'), obfsPwd = q.get('obfs-password');
  if (obfs && obfsPwd) { p.obfs = obfs; p['obfs-password'] = obfsPwd; } // 缺 password 会导致整份配置加载失败
  return p;
}

export function parseVmess(u) {
  let j; try { j = JSON.parse(b64d(u.slice(8).split('#')[0])); } catch { return null; }
  if (!j.add || !j.port || !j.id) return null;
  const p = { name: j.ps || `vmess-${j.add}`, type: 'vmess', server: j.add, port: Number(j.port), uuid: j.id, alterId: Number(j.aid || 0), cipher: 'auto', udp: true };
  if (j.tls === 'tls') { p.tls = true; if (j.sni) p.servername = j.sni; else if (j.host) p.servername = j.host; }
  if (j.net === 'ws') { p.network = 'ws'; p['ws-opts'] = { path: j.path || '/' }; if (j.host) p['ws-opts'].headers = { Host: j.host }; }
  else if (j.net === 'grpc') { p.network = 'grpc'; p['grpc-opts'] = { 'grpc-service-name': j.path || '' }; }
  return p;
}

/** 单行 → 节点对象；不认识或解析失败返回 null（不抛） */
export function parseUri(line) {
  const u = String(line).trim();
  try {
    if (u.startsWith('vless://')) return parseVless(u);
    if (u.startsWith('trojan://')) return parseTrojan(u);
    if (u.startsWith('ss://')) return parseSS(u);
    if (u.startsWith('hysteria2://') || u.startsWith('hy2://')) return parseHysteria2(u);
    if (u.startsWith('vmess://')) return parseVmess(u);
  } catch { return null; }
  return null;
}

// 必填字段校验：缺字段会让整份配置加载失败（实测 proxy 3677: '' has unset fields: cipher）
export const 必填 = {
  ss: ['cipher', 'password'],
  ssr: ['cipher', 'password', 'protocol', 'obfs'],
  vmess: ['uuid'],
  vless: ['uuid'],
  trojan: ['password'],
  hysteria: ['auth-str'],
  hysteria2: ['password'],
  tuic: ['uuid', 'password'],
  anytls: ['password'],
};

export const 缺字段 = (p) => {
  const 字段 = 必填[p.type];
  if (!字段) return null;
  for (const k of 字段) {
    const v = p[k];
    if (v === undefined || v === null || String(v).trim() === '') return k;
  }
  return null;
};

// 配置合法性：Host/SNI 里有控制字符、path 里有坏的 % 转义，客户端/内核会直接报
// ERR_INVALID_CHAR / URI malformed（墙内实测抓到 3 个），这类和网络无关，CI 必须自己剔掉
export const 配置合法 = (p) => {
  const 坏 = /[\u0000-\u001F\u007F-\u009F]/;
  const host = String((p['ws-opts'] && p['ws-opts'].headers && p['ws-opts'].headers.Host) || '');
  const sni = String(p.servername || p.sni || '');
  const path = String((p['ws-opts'] && p['ws-opts'].path) || '');
  if (坏.test(host) || 坏.test(sni) || 坏.test(path)) return false;
  if (/\s/.test(host) || /\s/.test(sni)) return false;
  // % 后面必须是两位 hex，否则 decodeURI 会抛 URI malformed
  if (/%(?![0-9a-fA-F]{2})/.test(path)) return false;
  return true;
};

/** 汇总判定：任一校验收紧都从这里走，避免各处口径不一致 */
export const 允许类型 = new Set([
  'vmess', 'vless', 'trojan', 'ss', 'ssr', 'hysteria', 'hysteria2', 'tuic', 'anytls',
  'http', 'socks5', 'mieru', 'wireguard', 'snell',
]);

export const invalid = (p) =>
  !允许类型.has(String(p.type || '').toLowerCase()) ||
  !配置合法(p) ||
  !!缺字段(p) ||
  ((p.type === 'hysteria2' || p.type === 'hysteria') && p.obfs && !p['obfs-password']) ||
  !okReality(p);

/** 去重键：同类型 + 同服务器 + 同端口 + 同身份字段 */
export const dedupeKey = (p) => [p.type, p.server, p.port, p.uuid || p.password || p.cipher || ''].join('|').toLowerCase();
