// 离线夹具：让 engine 在无网络环境下跑完整链路，供 CI 回归。
// 只替换「取数据」这一层（抓取 / GitHub API），其余逻辑全部走真实代码。
import fs from 'node:fs';
import { 校验目标 } from './safety.mjs';

const 通配 = (map, key) => {
  if (map[key] !== undefined) return map[key];
  // 支持 "前缀*" 形式，方便一个夹具覆盖一族 URL
  for (const [k, v] of Object.entries(map)) {
    if (k.endsWith('*') && key.startsWith(k.slice(0, -1))) return v;
  }
  return undefined;
};

export function 建夹具抓取(file) {
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  const 抓取 = fx.fetches || {};
  const ghMap = fx.gh || {};
  const 调用记录 = [];

  const 假抓取 = async (url, opt = {}) => {
    调用记录.push(['fetch', url]);
    // 字面 IP 仍然过一遍 SSRF 判定：保证「内网/元数据被拦」这条在离线也测得到
    const 主机 = (() => { try { return new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; } })();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(主机) || 主机.includes(':')) await 校验目标(url);

    const 项 = 通配(抓取, url);
    if (项 === undefined) throw new Error(`夹具缺失: ${url}`);
    if (项.status && 项.status >= 400) throw new Error(`HTTP ${项.status}`);
    const body = 项.body ?? '';
    const maxBytes = opt.maxBytes ?? 5 * 1024 * 1024;
    if (Buffer.byteLength(body) > maxBytes) throw new Error(`响应超过上限 ${maxBytes}B`);
    return { status: 项.status || 200, url, contentType: 项.contentType || 'text/plain', body, bytes: Buffer.byteLength(body) };
  };

  const 假gh = async (path) => {
    调用记录.push(['gh', path]);
    const 项 = 通配(ghMap, path);
    if (项 === undefined) throw new Error(`夹具缺失(gh): ${path}`);
    return 项;
  };

  return { 抓取: 假抓取, gh: 假gh, 调用记录 };
}
