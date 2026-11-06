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
  };
  表.items[url] = 新;
  return 新;
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
    项.status = 'accepted';
  } else {
    项.fail += 1;
    项.consecutiveFail += 1;
    项.rejectReason = reason || '验证失败';
    if (项.consecutiveFail >= 3) 项.status = 'rejected';
    else if (项.status === 'accepted' && 项.consecutiveFail >= 2) 项.status = 'candidate';
  }
  return 项;
}

export function 汇总(表) {
  const 计数 = { accepted: 0, candidate: 0, rejected: 0 };
  for (const x of Object.values(表.items)) 计数[x.status] = (计数[x.status] || 0) + 1;
  return 计数;
}
