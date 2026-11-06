// 候选登记表：记录发现渠道、时间、验证次数、拒绝原因。
// 文件：sources.candidates.json（v2）。v1 是纯数组，读取时自动迁移。
import fs from 'node:fs';

const 空表 = { version: 2, updatedAt: null, items: {} };

export function 读登记表(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return structuredClone(空表); }
  if (Array.isArray(raw)) {
    // v1 迁移
    const items = {};
    for (const x of raw) {
      if (!x || !x.url) continue;
      items[x.url] = {
        url: x.url, channel: x.channel || 'legacy',
        firstSeen: x.verifiedAt || null, lastSeen: x.verifiedAt || null,
        ok: 1, fail: 0, consecutiveFail: 0, nodes: x.nodes || 0,
        contentHash: x.contentHash || null,
        status: (x.nodes || 0) > 0 ? 'accepted' : 'candidate',
        rejectReason: null,
      };
    }
    return { ...structuredClone(空表), items };
  }
  if (!raw || typeof raw !== 'object' || !raw.items) return structuredClone(空表);
  return { version: 2, updatedAt: raw.updatedAt || null, items: raw.items };
}

export function 写登记表(file, 表) {
  表.version = 2;
  表.updatedAt = new Date().toISOString();
  const 有序 = Object.fromEntries(Object.entries(表.items).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  fs.writeFileSync(file, JSON.stringify({ ...表, items: 有序 }, null, 2) + '\n');
}

export function 登记候选(表, { url, channel, now = new Date().toISOString() }) {
  const 现有 = 表.items[url];
  if (现有) {
    现有.lastSeen = now;
    if (!现有.channel) 现有.channel = channel;
    return 现有;
  }
  const 新 = {
    url, channel, firstSeen: now, lastSeen: now,
    ok: 0, fail: 0, consecutiveFail: 0, nodes: 0,
    contentHash: null, status: 'candidate', rejectReason: null,
    score: 0, mirrorOf: null,
  };
  表.items[url] = 新;
  return 新;
}

/** 来源信誉分：成功加权、失败重罚、节点数取对数（避免超大源碾压一切） */
export function 计算分数(项) {
  const n = Math.max(1, 项.nodes || 0);
  const 原始 = (项.ok || 0) * 2 - (项.fail || 0) * 3 + Math.log2(n);
  return Number(原始.toFixed(2));
}

/**
 * 记录一次验证结果。
 * 连续失败 3 次 → rejected（自动隔离，不要求人工审批）；已 accepted 的连挂 2 次 → 降回 candidate。
 */
export function 记录结果(表, url, { ok, nodes = 0, contentHash = null, reason = null }) {
  const 项 = 表.items[url];
  if (!项) return null;
  if (ok) {
    项.ok += 1;
    项.consecutiveFail = 0;
    项.nodes = nodes;
    项.contentHash = contentHash;
    项.rejectReason = null;
    项.mirrorOf = null;
    项.status = 'accepted';
  } else {
    项.fail += 1;
    项.consecutiveFail += 1;
    项.rejectReason = reason || '验证失败';
    if (项.consecutiveFail >= 3) 项.status = 'rejected';
    else if (项.status === 'accepted' && 项.consecutiveFail >= 2) 项.status = 'candidate';
  }
  项.score = 计算分数(项);
  return 项;
}

/** 内容哈希相同 = 同一份订阅的镜像；只保留分数最高的一条，其余标 mirror */
export function 标记镜像(表, urls) {
  const 按哈希 = new Map();
  for (const u of urls) {
    const 项 = 表.items[u];
    if (!项 || 项.status !== 'accepted' || !项.contentHash) continue;
    const 组 = 按哈希.get(项.contentHash) || [];
    组.push(项);
    按哈希.set(项.contentHash, 组);
  }
  let 镜像数 = 0;
  for (const [, 组] of 按哈希) {
    if (组.length < 2) continue;
    组.sort((a, b) => (b.score || 0) - (a.score || 0) || b.nodes - a.nodes || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    const 主 = 组[0];
    for (const 项 of 组.slice(1)) {
      项.status = 'mirror';
      项.mirrorOf = 主.url;
      项.rejectReason = `内容与 ${主.url} 相同`;
      镜像数++;
    }
  }
  return 镜像数;
}

export function 汇总(表) {
  const 计数 = { accepted: 0, candidate: 0, rejected: 0, mirror: 0 };
  for (const x of Object.values(表.items)) 计数[x.status] = (计数[x.status] || 0) + 1;
  return 计数;
}
