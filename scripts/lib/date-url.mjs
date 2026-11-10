// 动态日期订阅地址：不少免费节点站按天换文件名（yoyapai / freeclashnode / mlfenx 都是），
// 写死日期第二天就 404。这里把 URL 里的占位符按「北京时间」展开，并给出「今天→昨天」的退化序列：
// 发布方往往在当天稍晚才生成文件，早上先取昨天那份，避免整条源在当天过早判定为死。
//
// 占位符（两种写法等价，**推荐 __X__**）：
//   ${Y} / __Y__     四位年（2026）
//   ${M} / __M__     两位月（11）
//   ${D} / __D__     两位日（10）
//   ${YMD} / __YMD__ 八位年月日（20261110）
//
// 为什么推荐 __X__：发现引擎会先把候选 URL 过一遍 `new URL().toString()`，
// 花括号会被百分号转义成 %7B/%7D ⇒ 模板失效（实测踩过：`$%7BYMD%7D`）。
// 下划线+字母不受 URL 归一化影响。
//
// 用法：
//   import { 展开, 日期变体 } from './date-url.mjs';
//   日期变体('https://x/__Y__/__M__/0-__YMD__.yaml')  // => [今天, 昨天]

const 北京偏移ms = 8 * 3600 * 1000;
const 模板正则 = /\$\{[YMD]+\}|__YMD__|__Y__|__M__|__D__/;

function 取日期(offsetDays = 0) {
  const d = new Date(Date.now() + 北京偏移ms + offsetDays * 86400 * 1000);
  const Y = String(d.getUTCFullYear());
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  return { Y, M, D, YMD: Y + M + D };
}

/** 把一个带占位符的 URL 展开成具体日期；不含占位符则原样返回 */
export function 展开(url, offsetDays = 0) {
  if (typeof url !== 'string' || !模板正则.test(url)) return url;
  const { Y, M, D, YMD } = 取日期(offsetDays);
  return url
    .replace(/\$\{YMD\}|__YMD__/g, YMD)
    .replace(/\$\{Y\}|__Y__/g, Y)
    .replace(/\$\{M\}|__M__/g, M)
    .replace(/\$\{D\}|__D__/g, D);
}

/** 抓取用的候选序列：带日期占位符的源给「今天、昨天」，其余原样一条 */
export function 日期变体(url) {
  if (typeof url !== 'string' || !模板正则.test(url)) return [url];
  return [展开(url, 0), 展开(url, -1)];
}

/** 是否含日期占位符（日志/文档用） */
export const 是否动态日期 = (url) => typeof url === 'string' && 模板正则.test(url);
