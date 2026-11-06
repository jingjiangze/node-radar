// 外部抓取的安全底座：网页/Telegram/订阅内容都能携带任意 URL，
// 直接请求可能被用来打本机、内网、云平台元数据（169.254.169.254）。
// 规则参考 SHUNZI88/proxysub 的 net_safety 与 lanzm/MetaFetch：解析全部 A/AAAA、拒绝非公网、
// 关闭自动重定向并逐跳重新校验。
import dns from 'node:dns/promises';

const 私网v4 = [
  [/^0\./, '0.0.0.0/8'],
  [/^10\./, '10/8'],
  [/^127\./, '127/8'],
  [/^169\.254\./, '169.254/16（含云元数据）'],
  [/^172\.(1[6-9]|2\d|3[01])\./, '172.16/12'],
  [/^192\.168\./, '192.168/16'],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, '100.64/10 CGNAT'],
  [/^192\.0\.(0|2)\./, '192.0.0/24 或 192.0.2/24'],
  [/^198\.(1[89]|51)\./, '198.18/15 或 198.51.100/24'],
  [/^203\.0\.113\./, '203.0.113/24'],
  [/^22[4-9]\./, '组播'],
  [/^2[3-5]\d\./, '保留/组播'],
];

const 私网v6 = [
  [/^::1$/, '::1'],
  [/^::$/, '未指定'],
  [/^fe80:/i, 'fe80::/10 链路本地'],
  [/^f[cd][0-9a-f]{2}:/i, 'fc00::/7 唯一本地'],
  [/^ff[0-9a-f]{2}:/i, 'ff00::/8 组播'],
  [/^2001:db8:/i, '文档地址'],
  [/^2001:0:/i, 'Teredo'],
];

export function 是否私网地址(ip) {
  const 清理 = String(ip).replace(/^\[|\]$/g, '');
  // IPv4-mapped IPv6：::ffff:1.2.3.4
  const 映射 = 清理.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (映射) return 是否私网地址(映射[1]);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(清理)) {
    for (const [re, 名] of 私网v4) if (re.test(清理)) return 名;
    return null;
  }
  for (const [re, 名] of 私网v6) if (re.test(清理)) return 名;
  return null;
}

const 允许端口 = (port, protocol) => {
  if (!port) return true;
  if (port === 80 || port === 443) return true;
  return port >= 1024 && port <= 65535; // CF 常用 2053/2083/2087 等
};

/** 解析并校验单个 URL；不合格抛错。 */
export async function 校验目标(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('URL 解析失败'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`协议不允许: ${u.protocol}`);
  if (u.username || u.password) throw new Error('URL 内含凭据');
  const 端口 = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!允许端口(端口, u.protocol)) throw new Error(`端口不允许: ${端口}`);

  const 主机 = u.hostname.replace(/^\[|\]$/g, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(主机) || 主机.includes(':')) {
    const 原因 = 是否私网地址(主机);
    if (原因) throw new Error(`目标地址不可访问: ${原因}`);
    return { url: u, 地址: [主机] };
  }

  let 记录;
  try {
    记录 = await dns.lookup(主机, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(`DNS 解析失败: ${e.code || e.message}`);
  }
  if (!记录.length) throw new Error('DNS 无记录');
  for (const r of 记录) {
    const 原因 = 是否私网地址(r.address);
    if (原因) throw new Error(`目标解析到非公网地址 ${r.address}（${原因}）`);
  }
  return { url: u, 地址: 记录.map((r) => r.address) };
}

const UA = 'node-radar/discovery (+https://github.com/jingjiangze/node-radar)';

/**
 * 安全抓取：逐跳校验 + 手动重定向 + 体积/时间上限。
 * 注意：DNS 校验与实际连接之间存在 TOCTOU 窗口；这里只抓公开订阅地址，风险可接受，
 * 但如果要抓任意用户输入，应改成把校验过的 IP 固定进连接（自定义 dispatcher）。
 */
export async function 安全抓取(url, opt = {}) {
  const 最大字节 = opt.maxBytes ?? 5 * 1024 * 1024;
  const 超时 = opt.timeoutMs ?? 15000;
  const 最大跳转 = opt.maxRedirects ?? 3;
  const 允许类型 = opt.accept;

  let 当前 = url;
  for (let 跳 = 0; 跳 <= 最大跳转; 跳++) {
    await 校验目标(当前);
    const r = await fetch(当前, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, ...(允许类型 ? { Accept: 允许类型 } : {}) },
      signal: AbortSignal.timeout(超时),
    });

    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) throw new Error(`重定向缺少 Location (${r.status})`);
      当前 = new URL(loc, 当前).toString();
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const 声明长度 = Number(r.headers.get('content-length') || 0);
    if (声明长度 > 最大字节) throw new Error(`响应过大 ${声明长度}B`);

    const 分片 = [];
    let 累计 = 0;
    for await (const chunk of r.body) {
      累计 += chunk.length;
      if (累计 > 最大字节) throw new Error(`响应超过上限 ${最大字节}B`);
      分片.push(chunk);
    }
    return {
      status: r.status,
      url: 当前,
      contentType: r.headers.get('content-type') || '',
      body: Buffer.concat(分片).toString('utf8'),
      bytes: 累计,
    };
  }
  throw new Error('重定向次数超限');
}
