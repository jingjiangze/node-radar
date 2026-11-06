// 把「一分机场」那套规则搬进公开池订阅
// 规则真源：ruleset.ini（gist）+ 17 个 .list（sub.jiangjiangze.icu，每行一条、目标组由 .ini 指定）
// 展开成 Clash 原生 rules，避免客户端再去拉 rule-providers。
import dns from 'node:dns';

// GitHub runner 上 IPv6 首选会直接 UND_ERR_CONNECT_TIMEOUT（实测前几个规则集全超时），强制 IPv4
dns.setDefaultResultOrder('ipv4first');

export const RULESET_INI =
  'https://gist.githubusercontent.com/jingjiangze/5521603a73532bae0c53d8a600610e14/raw/ruleset.ini';

const 兜底规则 = ['DOMAIN-SUFFIX,cn,DIRECT', 'GEOIP,CN,DIRECT', 'GEOSITE,cn,DIRECT', 'GEOSITE,private,DIRECT'];

const fetchText = async (url, ms = 20000) => {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      lastErr = e;
      await new Promise((s) => setTimeout(s, 800 * (i + 1)));
    }
  }
  throw new Error(`${url} → ${lastErr?.message || lastErr}${lastErr?.cause ? '/' + (lastErr.cause.code || lastErr.cause.message) : ''}`);
};

// 内置兜底：gist 拉不到时仍能按同一顺序展开（改规则时同步这里）
const 内置规则集 = [
  ['DIRECT', 'r00-dogfight-v3.list'],
  ['DIRECT', 'r00b-steam-direct.list'],
  ['DIRECT', 'r00c1-gh-direct.list'],
  ['一分机场', 'r00c2-gh-proxy.list'],
  ['GH直连优先', 'r00c3-gh-fallback.list'],
  ['GH直连优先', 'r01.list'],
  ['直连优先', 'r02.list'],
  ['一分机场', 'r03.list'],
  ['DIRECT', 'r04.list'],
  ['一分机场', 'r05.list'],
  ['DIRECT', 'r06.list'],
  ['一分机场', 'r07.list'],
  ['REJECT', 'r08.list'],
  ['一分机场', 'r09.list'],
  ['DIRECT', 'r10.list'],
  ['一分机场', 'r11.list'],
];
const 规则集根 = 'https://sub.jiangjiangze.icu/ruleset/';

// 行内带 no-resolve 的规则，目标组要插在它前面：IP-CIDR,x/y,no-resolve → IP-CIDR,x/y,TARGET,no-resolve
const 加目标 = (line, target) => {
  const parts = line.split(',').map((s) => s.trim());
  const 末尾无解析 = parts[parts.length - 1].toLowerCase() === 'no-resolve';
  if (末尾无解析) return [...parts.slice(0, -1), target, 'no-resolve'].join(',');
  return [...parts, target].join(',');
};

/**
 * @returns {Promise<{rules: string[], 来源: string}>}
 */
export async function buildRules(log = console.log) {
  let 条目 = [];
  let 来源说明 = '';
  try {
    const ini = await fetchText(RULESET_INI);
    for (const line of ini.split(/\r?\n/)) {
      const m = line.match(/^ruleset\s*=\s*([^,]+),(.+)$/i);
      if (m) 条目.push({ target: m[1].trim(), url: m[2].trim() });
    }
    if (!条目.length) throw new Error('ruleset.ini 里没有 ruleset= 条目');
    来源说明 = 'ruleset.ini';
  } catch (e) {
    log(`[rules] gist 拉取失败(${e.message})，改用内置清单`);
    条目 = 内置规则集.map(([target, file]) => ({ target, url: 规则集根 + file }));
    来源说明 = '内置清单';
  }

  try {
    const rules = [];
    let 失败 = 0;
    for (const { target, url } of 条目) {
      let text;
      try {
        text = await fetchText(url);
      } catch (e) {
        失败++;
        log(`[rules] 规则集失败: ${e.message}`);
        continue;
      }
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        if (line.includes(',')) rules.push(加目标(line, target));
      }
    }
    if (!rules.length) throw new Error('一个规则集都没拉到');
    rules.push(...兜底规则);
    rules.push('MATCH,一分机场');
    log(`[rules] ${来源说明}，${条目.length} 个规则集（失败 ${失败}），共 ${rules.length} 条规则`);
    return { rules, 来源: `${来源说明} + ${条目.length} 个 .list（失败 ${失败}）` };
  } catch (e) {
    log(`[rules] 展开失败(${e.message})，退回仅 MATCH`);
    return { rules: ['MATCH,🌐 公共节点'], 来源: `fallback: ${e.message}` };
  }
}

// 池订阅里复刻主订阅的分组名，否则规则里的 一分机场 / 直连优先 / GH直连优先 无处可指
export const 别名分组 = [
  { name: '♻️ 自动选择', type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 3600, tolerance: 50, lazy: true, proxies: ['🌐 公共节点'] },
  { name: '☑️ 手动切换', type: 'select', proxies: ['♻️ 自动选择', '🌐 公共节点', 'DIRECT'] },
  { name: '📶 官方优选', type: 'select', proxies: ['♻️ 自动选择', 'DIRECT'] },
  { name: '一分机场', type: 'select', proxies: ['♻️ 自动选择', '☑️ 手动切换', '📶 官方优选', 'DIRECT'] },
  { name: '直连优先', type: 'fallback', proxies: ['DIRECT', '一分机场'], url: 'https://dl.jiangjiangze.icu/', interval: 60, lazy: true },
  { name: 'GH直连优先', type: 'fallback', proxies: ['DIRECT', '一分机场'], url: 'https://github.com/', interval: 30, lazy: true },
];
