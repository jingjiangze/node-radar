// 六类发现适配器。每个适配器只负责「产出候选 URL」，抓取与校验统一由 engine 做。
// 统一签名：{ name, 说明, async run(ctx) => [{ url, note? }] }
// ctx = { 抓取, gh, 日志, 上限, 配置 }
import { 抽链接, 抽节点链接, 像订阅, 是噪声 } from './normalize.mjs';

const 去重 = (arr) => [...new Set(arr.filter(Boolean))];

/** A. GitHub Code Search：找仓库里没列在根目录的订阅文件 */
export const githubCode = {
  name: 'github-code',
  说明: 'GitHub 代码搜索，按文件名/内容特征找订阅文件',
  async run(ctx) {
    if (!ctx.token) {
      ctx.日志('[github-code] 无 GITHUB_TOKEN，跳过（代码搜索必须带 token）');
      return [];
    }
    const 查询 = [
      'filename:clash.yaml "proxy-groups" "proxies"',
      'filename:clash.yml "proxy-groups"',
      'filename:sub.txt vless://',
      'filename:nodes.yaml "type: vless"',
      'path:/ "subscribe?token=" language:YAML',
    ];
    const out = [];
    const 分支缓存 = new Map();
    const 取默认分支 = async (fullName) => {
      if (分支缓存.has(fullName)) return 分支缓存.get(fullName);
      let br = 'main';
      try { br = (await ctx.gh(`/repos/${fullName}`)).default_branch || 'main'; } catch { }
      分支缓存.set(fullName, br);
      return br;
    };
    for (const q of 查询.slice(0, ctx.上限.codeQueries ?? 5)) {
      try {
        const r = await ctx.gh(`/search/code?per_page=20&q=${encodeURIComponent(q)}`);
        for (const item of r.items || []) {
          const full = item.repository.full_name;
          const br = await 取默认分支(full);
          out.push({
            // code search 的 html_url 带的是某个 commit sha（会过期），改用默认分支指向最新
            url: `https://raw.githubusercontent.com/${full}/${br}/${item.path}`,
            note: `code:${full}`,
          });
        }
      } catch (e) {
        ctx.日志(`[github-code] 查询失败 ${q}: ${e.message}`);
      }
      await new Promise((s) => setTimeout(s, 700)); // 代码搜索限流 10/min
    }
    return 去重(out.map((x) => x.url)).map((u) => ({ url: u, note: 'github-code' })).slice(0, ctx.上限.perAdapter);
  },
};

/** B. GitHub 仓库搜索（保留原有能力，作为基础入口） */
export const githubSearch = {
  name: 'github-search',
  说明: 'GitHub 仓库搜索 + 根目录文件嗅探（按真实目录列，不盲猜文件名）',
  async run(ctx) {
    const 查询 = ctx.配置.githubQueries || [];
    const 名称提示 = /(^|[._-])(sub|subs|subscribe|subscription|clash|list|nodes?|v2ray|proxies|provider)([._-]|$)/i;
    const 扩展名 = /\.(yaml|yml|txt|json)$/i;
    const out = [];
    for (const q of 查询.slice(0, ctx.上限.repoQueries ?? 5)) {
      try {
        const r = await ctx.gh(`/search/repositories?sort=updated&order=desc&per_page=10&q=${encodeURIComponent(q)}`);
        for (const repo of r.items || []) {
          const br = repo.default_branch || 'main';
          let 文件 = [];
          try {
            const listing = await ctx.gh(`/repos/${repo.full_name}/contents/?ref=${br}`);
            文件 = (Array.isArray(listing) ? listing : [])
              .filter((f) => f.type === 'file' && 扩展名.test(f.name) && 名称提示.test(f.name))
              .slice(0, 3)
              .map((f) => f.name);
          } catch (e) {
            // 列目录失败（空仓库/超大仓库）就退化成只试最可能的两个文件名
            文件 = ['clash.yaml', 'sub.txt'];
          }
          for (const f of 文件) {
            out.push({ url: `https://raw.githubusercontent.com/${repo.full_name}/${br}/${f}`, note: `repo:${repo.full_name}` });
          }
        }
      } catch (e) {
        ctx.日志(`[github-search] 查询失败 ${q}: ${e.message}`);
      }
      await new Promise((s) => setTimeout(s, 800));
    }
    return 去重(out.map((x) => x.url)).map((u) => ({ url: u, note: 'github-search' })).slice(0, ctx.上限.perAdapter);
  },
};

/** C. 种子源：已有聚合项目的来源清单 / README，从里面继续发现 */
export const seeds = {
  name: 'seeds',
  说明: '已知公开聚合项目的来源清单与 README',
  async run(ctx) {
    const repos = ctx.配置.seedRepos || [];
    const out = [];
    for (const repo of repos) {
      for (const 路径 of ['README.md', 'sources.json', 'sources.yaml', 'config.json', 'sub_list.txt', 'list.txt']) {
        for (const branch of ['main', 'master']) {
          const url = `https://raw.githubusercontent.com/${repo}/${branch}/${路径}`;
          try {
            const r = await ctx.抓取(url, { maxBytes: 512 * 1024, timeoutMs: 12000 });
            const 链接 = 抽链接(r.body).filter((l) => 像订阅(l) && !是噪声(l));
            for (const l of 链接) out.push({ url: l, note: `seed:${repo}` });
            break; // 命中就不再试另一个分支
          } catch { }
        }
      }
    }
    return 去重(out.map((x) => x.url)).map((u) => ({ url: u, note: 'seed' })).slice(0, ctx.上限.perAdapter);
  },
};

/** D. 递归发现：从已抓到的页面继续抽一层（深度 1、单页上限可配） */
export const recursive = {
  name: 'recursive',
  说明: '对给定页面抽一层子链接（深度 1），只保留像订阅的',
  async run(ctx) {
    const 种子 = ctx.配置.recursiveSeeds || [];
    const perPage = ctx.上限.linksPerPage ?? 100;
    const out = [];
    for (const url of 种子.slice(0, ctx.上限.recursivePages ?? 5)) {
      try {
        const r = await ctx.抓取(url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15000 });
        const 链接 = 抽链接(r.body).slice(0, perPage);
        for (const l of 链接) {
          if (像订阅(l) && !是噪声(l)) out.push({ url: l, note: `recursive:${url}` });
        }
      } catch (e) {
        ctx.日志(`[recursive] ${url} 失败: ${e.message}`);
      }
    }
    return 去重(out.map((x) => x.url)).map((u) => ({ url: u, note: 'recursive' })).slice(0, ctx.上限.perAdapter);
  },
};

/** E. Telegram 公开频道：抓 https://t.me/s/<channel>，链接与原始节点分开处理 */
export const telegram = {
  name: 'telegram',
  说明: 'Telegram 公开频道网页版',
  async run(ctx) {
    const 频道 = ctx.配置.telegramChannels || [];
    if (!频道.length) {
      ctx.日志('[telegram] 未配置频道，跳过');
      return [];
    }
    const out = [];
    for (const ch of 频道.slice(0, ctx.上限.channels ?? 5)) {
      const url = `https://t.me/s/${encodeURIComponent(ch)}`;
      try {
        const r = await ctx.抓取(url, { maxBytes: 3 * 1024 * 1024, timeoutMs: 20000 });
        const 链接 = 抽链接(r.body).slice(0, ctx.上限.linksPerPage ?? 300);
        // 每个频道每轮最多 3 个新订阅源
        const 订阅候选 = 去重(链接.filter((l) => 像订阅(l) && !是噪声(l))).slice(0, ctx.上限.perChannel ?? 3);
        for (const l of 订阅候选) out.push({ url: l, note: `tg:${ch}` });
        // 原始节点链接单独记一笔（不直接当订阅，供人工/后续聚合）
        const 节点 = 抽节点链接(r.body);
        if (节点.length) ctx.日志(`[telegram] ${ch} 命中 ${节点.length} 条原始节点链接（不直接入库）`);
      } catch (e) {
        ctx.日志(`[telegram] ${ch} 失败: ${e.message}`);
      }
      await new Promise((s) => setTimeout(s, 3000)); // 频道之间礼让
    }
    return out.slice(0, ctx.上限.perAdapter);
  },
};

/** F. 网页 / RSS / Atom / JSON Feed */
export const feed = {
  name: 'feed',
  说明: 'RSS/Atom/JSON Feed/普通网页里的订阅链接',
  async run(ctx) {
    const 源 = ctx.配置.feeds || [];
    if (!源.length) {
      ctx.日志('[feed] 未配置 feed，跳过');
      return [];
    }
    const out = [];
    for (const url of 源.slice(0, ctx.上限.feeds ?? 10)) {
      try {
        const r = await ctx.抓取(url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15000 });
        let 候选 = [];
        if (/<rss|<feed|<rdf:RDF/i.test(r.body)) {
          候选 = [...r.body.matchAll(/<link>([^<]+)<\/link>|<link[^>]+href="([^"]+)"/gi)]
            .map((m) => m[1] || m[2])
            .filter(Boolean);
        } else if (/^\s*[[{]/.test(r.body)) {
          try {
            const j = JSON.parse(r.body);
            const 走 = (x) => {
              if (typeof x === 'string') { if (/^https?:/.test(x)) 候选.push(x); return; }
              if (Array.isArray(x)) return x.forEach(走);
              if (x && typeof x === 'object') return Object.values(x).forEach(走);
            };
            走(j);
          } catch { }
        }
        if (!候选.length) 候选 = 抽链接(r.body);
        for (const l of 去重(候选).slice(0, ctx.上限.linksPerPage ?? 100)) {
          if (像订阅(l) && !是噪声(l)) out.push({ url: l, note: `feed:${url}` });
        }
      } catch (e) {
        ctx.日志(`[feed] ${url} 失败: ${e.message}`);
      }
    }
    return 去重(out.map((x) => x.url)).map((u) => ({ url: u, note: 'feed' })).slice(0, ctx.上限.perAdapter);
  },
};

/** G. 搜索引擎：默认关闭（反爬 + 页面结构易变），保留接口 */
export const search = {
  name: 'search',
  说明: '搜索引擎定向发现（默认关闭）',
  async run(ctx) {
    if (!ctx.配置.search?.enabled) {
      ctx.日志('[search] 默认关闭');
      return [];
    }
    ctx.日志('[search] 已启用但未实现具体引擎，请在此接入自建 SearXNG 等合规入口');
    return [];
  },
};

export const 全部适配器 = [githubCode, githubSearch, seeds, recursive, telegram, feed, search];
