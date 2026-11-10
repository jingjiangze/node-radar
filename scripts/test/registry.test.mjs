// 候选登记表状态机：瞬时失败不判死、rejected 到期复活、复验按最久未验优先
import test from 'node:test';
import assert from 'node:assert/strict';
import { 记录结果, 复活过期拒绝, 取待复验 } from '../discovery/registry.mjs';

const 新表 = () => ({ version: 2, items: {} });
const 登记 = (表, url) => { 表.items[url] = { url, channel: 't', firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), ok: 0, fail: 0, consecutiveFail: 0, nodes: 0, contentHash: null, status: 'candidate', rejectReason: null, score: 0, mirrorOf: null }; };

test('连续 3 次真失败 → rejected，且记录 rejectedAt', () => {
  const t = 新表(); 登记(t, 'https://a/s');
  for (let i = 0; i < 3; i++) 记录结果(t, 'https://a/s', { ok: false, reason: 'HTTP 500' });
  assert.equal(t.items['https://a/s'].status, 'rejected');
  assert.ok(t.items['https://a/s'].rejectedAt);
});

test('瞬时失败（429/超时）不计入连续失败，也不会被判死', () => {
  const t = 新表(); 登记(t, 'https://gitlab.com/x');
  记录结果(t, 'https://gitlab.com/x', { ok: true, nodes: 30 });
  for (let i = 0; i < 5; i++) 记录结果(t, 'https://gitlab.com/x', { ok: false, reason: 'HTTP 429', transient: true });
  const 项 = t.items['https://gitlab.com/x'];
  assert.equal(项.status, 'accepted');
  assert.equal(项.consecutiveFail, 0);
  assert.equal(项.transientFails, 5);
});

test('rejected 满 retryDays 天复活成 candidate', () => {
  const t = 新表(); 登记(t, 'https://b/s');
  for (let i = 0; i < 3; i++) 记录结果(t, 'https://b/s', { ok: false, reason: 'x' });
  assert.equal(t.items['https://b/s'].status, 'rejected');
  // 未到期：不复活
  assert.equal(复活过期拒绝(t, { retryDays: 7 }), 0);
  // 8 天后：复活
  assert.equal(复活过期拒绝(t, { retryDays: 7, now: Date.now() + 8 * 86400e3 }), 1);
  assert.equal(t.items['https://b/s'].status, 'candidate');
});

test('取待复验：按 lastValidatedAt 最久优先，跳过本轮已验、跳过 mirror/rejected', () => {
  const t = 新表();
  for (const u of ['https://c/1', 'https://c/2', 'https://c/3']) 登记(t, u);
  t.items['https://c/1'].status = 'accepted'; t.items['https://c/1'].lastValidatedAt = '2026-01-01T00:00:00Z';
  t.items['https://c/2'].status = 'accepted'; t.items['https://c/2'].lastValidatedAt = '2026-06-01T00:00:00Z';
  t.items['https://c/3'].status = 'mirror';
  const got = 取待复验(t, { limit: 5, skip: new Set(['https://c/2']) });
  assert.deepEqual(got.map((x) => x.url), ['https://c/1']);
});
