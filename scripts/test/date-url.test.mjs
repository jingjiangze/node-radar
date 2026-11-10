// 动态日期订阅地址的单测：把「今天/昨天」固定住，避免测试依赖运行日期
import test from 'node:test';
import assert from 'node:assert/strict';
import { 展开, 日期变体, 是否动态日期 } from '../lib/date-url.mjs';

const 北京偏移 = 8 * 3600 * 1000;
const 今天 = () => {
  const d = new Date(Date.now() + 北京偏移);
  return {
    Y: String(d.getUTCFullYear()),
    M: String(d.getUTCMonth() + 1).padStart(2, '0'),
    D: String(d.getUTCDate()).padStart(2, '0'),
  };
};

test('不含占位符的 URL 原样返回，且只有一个变体', () => {
  const u = 'https://x.example/sub.yaml';
  assert.equal(展开(u), u);
  assert.deepEqual(日期变体(u), [u]);
  assert.equal(是否动态日期(u), false);
});

test('${Y}/${M}/${D}/${YMD} 按北京时间展开', () => {
  const { Y, M, D } = 今天();
  const u = 'https://x.example/${Y}/${M}/${D}-${YMD}.yaml';
  assert.equal(展开(u), `https://x.example/${Y}/${M}/${D}-${Y}${M}${D}.yaml`);
});

test('日期变体返回 [今天, 昨天] 两条', () => {
  const u = 'https://x.example/${YMD}.yaml';
  const v = 日期变体(u);
  assert.equal(v.length, 2);
  const { Y, M, D } = 今天();
  assert.equal(v[0], `https://x.example/${Y}${M}${D}.yaml`);
  const y = new Date(Date.now() + 北京偏移 - 86400000);
  const ymd = `${y.getUTCFullYear()}${String(y.getUTCMonth() + 1).padStart(2, '0')}${String(y.getUTCDate()).padStart(2, '0')}`;
  assert.equal(v[1], `https://x.example/${ymd}.yaml`);
});

test('占位符重复出现时全部替换', () => {
  const { Y } = 今天();
  assert.equal(展开('${Y}-${Y}-${Y}'), `${Y}-${Y}-${Y}`);
});
