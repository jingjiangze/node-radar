// 把「一分机场」那套规则搬进公开池订阅
// 规则真源：ruleset.ini（gist）+ 17 个 .list（sub.jiangjiangze.icu，每行一条、目标组由 .ini 指定）
// 展开成 Clash 原生 rules，避免客户端再去拉 rule-providers。

export const RULESET_INI =
  'https://gist.githubusercontent.com/jingjiangze/5521603a73532bae0c53d8a600610e14/raw/ruleset.ini';

const 兜底规则 = ['DOMAIN-SUFFIX,cn,DIRECT', 'GEOIP,CN,DIRECT', 'GEOSITE,cn,DIRECT', 'GEOSITE,private,DIRECT'];

const fetchText = async (url, ms = 20000) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return await r.text();
};

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
  try {
    const ini = await fetchText(RULESET_INI);
    const 条目 = [];
    for (const line of ini.split(/\r?\n/)) {
      const m = line.match(/^ruleset\s*=\s*([^,]+),(.+)$/i);
      if (m) 条目.push({ target: m[1].trim(), url: m[2].trim() });
    }
    if (!条目.length) throw new Error('ruleset.ini 里没有 ruleset= 条目');

    const rules = [];
    for (const { target, url } of 条目) {
      const text = await fetchText(url);
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        if (line.includes(',')) rules.push(加目标(line, target));
      }
    }
    rules.push(...兜底规则);
    rules.push('MATCH,一分机场');
    log(`[rules] 展开 ${条目.length} 个规则集，共 ${rules.length} 条规则`);
    return { rules, 来源: `ruleset.ini + ${条目.length} 个 .list` };
  } catch (e) {
    log(`[rules] 拉取规则集失败(${e.message})，退回仅 MATCH`);
    return { rules: ['MATCH,🌐 公共节点'], 来源: 'fallback' };
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
