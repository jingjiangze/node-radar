// 订阅内容解析：只做「能数出多少节点」这一件事，够判定可用性即可。
//
// 2026-11-10 修：原先用 /^\s*proxies\s*:\s*([\s\S]*?)(?=^\S)/ 取段，遇到**顶格**的列表项
// （`proxies:` 下一行直接是 `- name: ...`，这是合法 YAML，codeberg 上 igareck 那份就是）
// 会被 (?=^\S) 立刻截断成空串 ⇒ 931 条的源被判成 0 条。改成按行扫描，缩进/顶格都算。
export function 估节点数(text) {
  const 协议 = (t) => (t.match(/^(?:vmess|vless|trojan|ss|ssr|hysteria2?|hy2|tuic|anytls):\/\//gim) || []).length;

  const n = 协议(text);
  if (n > 0) return n;

  if (/^\s*proxies\s*:/m.test(text)) {
    const lines = text.split(/\r?\n/);
    const i = lines.findIndex((l) => /^\s*proxies\s*:/.test(l));
    if (i < 0) return 0;
    let count = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      const s = l.trim();
      if (!s) continue;
      if (/^[A-Za-z_"#]/.test(l)) break;   // 下一个顶层键 / 顶层注释 ⇒ 段结束
      // 一个节点恰好一行 name：可能是 `- name: x`（同名行）、`- {name: x}`（内联），
      // 也可能是 `- type: vless` + 下一行 `name: x`（实测 freeclashnode 就是这种）
      if (s.startsWith('name:') || s.startsWith('- name:') || /^-\s*\{\s*name:/.test(s)) count++;
    }
    return count;
  }

  // base64 编码的订阅
  try {
    const 解码 = Buffer.from(text.trim(), 'base64').toString('utf8');
    if (/^(?:vmess|vless|trojan|ss|ssr|hysteria2?|hy2|tuic|anytls):\/\//im.test(解码)) return 协议(解码);
  } catch { }

  return 0;
}
