#!/usr/bin/env node
// CI 回归：用离线夹具把「适配器 → 去重 → 校验 → 登记表 → 产物」整条链路跑两遍。
// 不依赖外网、不碰仓库文件（写临时目录），失败即非零退出。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const 目录 = path.dirname(fileURLToPath(import.meta.url));
const 引擎 = path.join(目录, 'engine.mjs');
const 夹具 = path.join(目录, 'fixtures', 'basic.json');
const 临时 = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-test-'));

const 跑 = (args) =>
  execFileSync(process.execPath, [引擎, ...args], {
    cwd: 临时,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_TOKEN: 'fixture-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const 读 = (f) => JSON.parse(fs.readFileSync(path.join(临时, f), 'utf8'));
let 步 = 0;
const 断言 = (名, fn) => {
  步++;
  try { fn(); console.log(`  ok  ${步}. ${名}`); }
  catch (e) { console.error(`  FAIL ${步}. ${名}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('— 第一轮（冷启动）—');
// 预置一条「旧版本产物」：没有 score 字段，验证历史条目会被回填
fs.writeFileSync(
  path.join(临时, 'sources.auto.json'),
  JSON.stringify([{ name: 'legacy', url: 'https://legacy.example/sub.yaml', nodes: 42, verifiedAt: '2026-01-01T00:00:00.000Z' }], null, 2)
);
const 输出1 = 跑(['--fixture=' + 夹具, '--out=' + 临时, '--only=github-code,seeds,recursive', '--budget=20']);
if (process.env.SHOW_ENGINE_LOG) console.log(输出1);

const auto1 = 读('sources.auto.json');
const 注册1 = 读('sources.candidates.json');
const 报告1 = 读('discovery-report.json');

断言('产物文件齐全且登记表是 v2', () => {
  assert.equal(注册1.version, 2);
  assert.ok(报告1.channels['github-code'], '报告里要有 github-code 渠道');
});

断言('合格的源进了正式清单', () => {
  const urls = auto1.map((x) => x.url);
  // good 与 dup 内容完全相同，只会有其中一条留下（另一条是 mirror）
  assert.ok(
    urls.includes('https://fixture.example/sub/good.yaml') || urls.includes('https://fixture.example/sub/dup.yaml'),
    'good/dup 至少一条应在正式清单'
  );
  assert.ok(urls.includes('https://fixture.example/sub/b64.txt'), 'base64 源应被识别');
  assert.ok(urls.includes('https://raw.githubusercontent.com/fixture/alpha/main/clash.yaml'), '代码搜索来源应在清单');
});

断言('节点数不足的被拒（低于 minNodes=20）', () => {
  assert.ok(!auto1.some((x) => x.url.includes('small.yaml')), 'small.yaml 不该进正式清单');
  const 项 = 注册1.items['https://fixture.example/sub/small.yaml'];
  assert.ok(项, 'small.yaml 应留在登记表里');
  assert.notEqual(项.status, 'accepted');
  assert.match(项.rejectReason || '', /节点数|不足/);
});

断言('SSRF：内网/元数据地址被拦', () => {
  const 项 = 注册1.items['http://169.254.169.254/sub?token=abc'];
  assert.ok(项, '该 URL 应被登记（进入候选）');
  assert.notEqual(项.status, 'accepted');
  assert.match(项.rejectReason || '', /非公网|不可访问/);
  assert.ok(!auto1.some((x) => x.url.includes('169.254')), '绝不能进正式清单');
});

断言('内容哈希去重：重复内容标 mirror 且不进正式清单', () => {
  const 重复 = 注册1.items['https://fixture.example/sub/dup.yaml'];
  assert.ok(重复, 'dup.yaml 应在登记表');
  const 另一条 = 注册1.items['https://fixture.example/sub/good.yaml'];
  // 两条内容一致：恰好一条 accepted、一条 mirror，且 mirrorOf 指向留下那条
  const 状态 = [重复.status, 另一条 && 另一条.status].sort().join(',');
  assert.ok(状态 === 'accepted,mirror', `应一留一镜像，实际 ${状态}`);
  const 镜像 = 重复.status === 'mirror' ? 重复 : 另一条;
  const 留存 = 重复.status === 'mirror' ? 另一条 : 重复;
  assert.equal(镜像.mirrorOf, 留存.url, 'mirrorOf 应指向保留的那条');
  assert.ok(!auto1.some((x) => x.url === 镜像.url), '镜像不该进正式清单');
  assert.ok(auto1.some((x) => x.url === 留存.url), '保留那条约应在正式清单');
});

断言('404 的源被记为失败而不是崩溃', () => {
  const 项 = 注册1.items['https://fixture.example/404.yaml'];
  assert.ok(项, '404.yaml 应留痕');
  assert.ok(!auto1.some((x) => x.url.includes('404.yaml')));
});

断言('正式清单带 score 且按分数排序', () => {
  assert.ok(auto1.every((x) => typeof x.score === 'number'), '每条都要有 score');
  const 分数 = auto1.map((x) => x.score);
  assert.deepEqual(分数, [...分数].sort((a, b) => b - a), '应按 score 降序');
});

断言('历史条目（无 score 的旧产物）被回填', () => {
  const 旧 = auto1.find((x) => x.url === 'https://legacy.example/sub.yaml');
  assert.ok(旧, '历史条目应被保留');
  assert.equal(typeof 旧.score, 'number', 'score 应被回填');
  assert.equal(旧.nodes, 42, 'nodes 不该被清掉');
});

console.log('— 第二轮（同一目录重跑，验证持久化与幂等）—');
跑(['--fixture=' + 夹具, '--out=' + 临时, '--only=github-code,seeds,recursive', '--budget=20']);
const 注册2 = 读('sources.candidates.json');
const auto2 = 读('sources.auto.json');

断言('重跑后登记表保留历史（ok 计数递增）', () => {
  const 项 = 注册2.items['https://fixture.example/sub/good.yaml'];
  assert.ok(项.ok >= 2, `ok 应 >=2，实际 ${项.ok}`);
});
断言('重跑后正式清单不重复', () => {
  const urls = auto2.map((x) => x.url);
  assert.equal(new Set(urls).size, urls.length, '不能有重复 URL');
});
断言('镜像判定稳定（两轮指向同一条）', () => {
  const 镜像1 = Object.values(注册1.items).find((x) => x.status === 'mirror' && x.url.includes('fixture.example/sub/'));
  const 镜像2 = Object.values(注册2.items).find((x) => x.status === 'mirror' && x.url.includes('fixture.example/sub/'));
  assert.ok(镜像1 && 镜像2, '两轮都应有镜像条目');
  assert.equal(镜像2.url, 镜像1.url, '镜像归属不该在两轮之间漂移');
  assert.equal(镜像2.mirrorOf, 镜像1.mirrorOf, 'mirrorOf 也不该漂移');
});

console.log(`\n${process.exitCode ? '有失败项' : '全部通过'}（临时目录 ${临时}）`);
