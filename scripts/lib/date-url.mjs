// 动态日期订阅地址：不少免费节点站按天换文件名（yoyapai / freeclashnode / mlfenx 都是），
// 写死日期第二天就 404。这里把 URL 里的占位符按「北京时间」展开，并给出「今天→昨天」的退化序列：
// 发布方往往在当天稍晚才生成文件，早上先取昨天那份，避免整条源在当天过早判定为死。
//
// 占位符：
//   ${Y}   四位年（2026）
//   ${M}   两位月（11）
//   ${D}   两位日（10）
//   ${YMD} 八位年月日（20261110）
//
// 用法：
//   import { 展开, 日期变体 } from './date-url.mjs';
//   日期变体('https://x/${Y}/${M}/0-${YMD}.yaml')  // => [今天, 昨天]

const 北京偏移ms = 8 * 3600 * 1000;

function 取日期(offsetDays = 0) {
  const d = new Date(Date.now() + 北京偏移ms + offsetDays * 86400 * 1000);
  const Y = String(d.getUTCFullYear());
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  return { Y, M, D, YMD: Y + M + D };
}

/** 把一个带占位符的 URL 展开成具体日期；不含占位符则原样返回 */
export function 展开(url, offsetDays = 0) {
  if (typeof url !== 'string' || !url.includes('${')) return url;
  const { Y, M, D, YMD } = 取日期(offsetDays);
  return url
    .replace(/\$\{YMD\}/g, YMD)
    .replace(/\$\{Y\}/g, Y)
    .replace(/\$\{M\}/g, M)
    .replace(/\$\{D\}/g, D);
}

/** 抓取用的候选序列：带日期占位符的源给「今天、昨天」，其余原样一条 */
export function 日期变体(url) {
  if (typeof url !== 'string' || !url.includes('${')) return [url];
  return [展开(url, 0), 展开(url, -1)];
}

/** 便于日志/登记：把占位符换成一个稳定的说明串（不要用于请求） */
export const 是否动态日期 = (url) => typeof url === 'string' && url.includes('${');
