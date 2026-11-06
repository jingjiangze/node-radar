// URL 归一化 / 订阅特征识别 / 内容哈希去重
import crypto from 'node:crypto';

const 跟踪参数 = /^(utm_|ref$|source$|from$|spm$|share_|_t$|timestamp$)/i;

/** 归一化：小写 scheme+host、去默认端口、去 fragment、去跟踪参数、保留其余 query（token 要留着） */
export function 归一化(url) {
  let u;
  try { u = new URL(url.trim()); } catch { return null; }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  const 保留 = [...u.searchParams.entries()].filter(([k]) => !跟踪参数.test(k));
  u.search = '';
  for (const [k, v] of 保留.sort((a, b) => (a[0] < b[0] ? -1 : 1))) u.searchParams.append(k, v);
  let s = u.toString();
  if (s.endsWith('?')) s = s.slice(0, -1);
  return s;
}

/** 只看内容不看参数，用于识别「同一份订阅的不同镜像」 */
export function 内容键(url) {
  const n = 归一化(url);
  if (!n) return null;
  const u = new URL(n);
  return `${u.hostname}${u.pathname}`.toLowerCase();
}

export const 内容哈希 = (text) => crypto.createHash('sha256').update(text).digest('hex');

const 订阅扩展名 = /\.(ya?ml|txt|json|conf)$/i;
const 订阅路径词 = /(sub|subs|subscribe|subscription|clash|v2ray|nodes?|proxies|provider|list)/i;
const 节点协议 = /^(vmess|vless|trojan|ss|ssr|hysteria2?|hy2|tuic|anytls):\/\//i;

/** 像不像「订阅地址」（而不是普通网页） */
export function 像订阅(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const p = u.pathname;
  if (订阅扩展名.test(p)) return true;
  if (订阅路径词.test(p)) return true;
  const q = u.search.toLowerCase();
  if (/token=|target=clash|flag=clash|sub=/.test(q)) return true;
  return false;
}

/** 从任意文本里抽 http(s) 链接 */
export function 抽链接(text) {
  const out = new Set();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]}\\]+/gi)) {
    let s = m[0].replace(/[.,;:!?]+$/, '');
    if (s.length > 8 && s.length < 2000) out.add(s);
  }
  return [...out];
}

/** 从任意文本里抽原始节点分享链接 */
export function 抽节点链接(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:vmess|vless|trojan|ss|ssr|hysteria2?|hy2|tuic|anytls):\/\/[^\s"'<>)\]}\\]+/gi)) {
    out.add(m[0].replace(/[.,;]+$/, ''));
  }
  return [...out];
}

// 订阅地址本身常以 /sub、?token= 结尾，不能被当成噪声
const 噪声路径 = /(^|\/)(readme|license|licence|contributing|code_of_conduct|issues|pull|pulls|wiki|actions|security|releases?|sponsors?|marketplace|topics|trending|about|pricing|contact|privacy|terms|login|signup)(\/|$)/i;
const 噪声主机 = /(^|\.)(twitter\.com|x\.com|facebook\.com|youtube\.com|discord\.gg|discord\.com|reddit\.com|telegram\.org|t\.me)$/i;
const 噪声文件 = /\.(png|jpe?g|gif|svg|webp|ico|zip|gz|tar|exe|apk|dmg|mp4|pdf)$/i;

export function 是噪声(link) {
  if (像订阅(link)) return false;
  let u;
  try { u = new URL(link); } catch { return true; }
  if (噪声主机.test(u.hostname)) return true;
  if (噪声文件.test(u.pathname)) return true;
  return 噪声路径.test(u.pathname);
}

export { 节点协议 };
