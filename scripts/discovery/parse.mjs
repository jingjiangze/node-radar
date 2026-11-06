// 订阅内容解析：只做「能数出多少节点」这一件事，够判定可用性即可。
export function 估节点数(text) {
  const 协议 = (t) => (t.match(/^(?:vmess|vless|trojan|ss|ssr|hysteria2?|hy2|tuic|anytls):\/\//gim) || []).length;

  let n = 协议(text);
  if (n > 0) return n;

  if (/^\s*proxies\s*:/m.test(text)) {
    const m = text.match(/^\s*proxies\s*:\s*([\s\S]*?)(?=^\S)/m);
    const 段 = m ? m[1] : text;
    return (段.match(/^\s*-\s*(?:\{\s*)?name\s*:/gm) || []).length;
  }

  // base64 编码的订阅
  try {
    const 解码 = Buffer.from(text.trim(), 'base64').toString('utf8');
    if (/^(?:vmess|vless|trojan|ss|ssr|hysteria2?|hy2|tuic|anytls):\/\//im.test(解码)) return 协议(解码);
  } catch { }

  return 0;
}
