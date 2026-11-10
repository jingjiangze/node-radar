// 产物校验的唯一入口：结构校验（js-yaml）+ 私有凭据断言 + 内核加载（mihomo -t）
//
// 以前这套逻辑散在三处且口径不同：
//   · ci.yml              只做 js-yaml 结构校验，不跑 mihomo
//   · aggregate.yml       跑 mihomo，但校验 clash-lite / speed-top（后者已不再产出）
//   · pipeline.yml        跑 mihomo，只校验 clash + clash-lite，没有私有凭据断言
// 现在统一到这里，三者都调它，改一处即可。
//
// 用法:
//   node scripts/ci/validate-dist.mjs                 # mihomo 缺失时跳过内核校验（用于 PR 的轻量检查）
//   node scripts/ci/validate-dist.mjs --require-mihomo # mihomo 缺失直接失败（发布路径必须用这个）
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

const REQUIRE_MIHOMO = process.argv.includes('--require-mihomo');
const DIST = ['dist/clash.yaml', 'dist/clash-lite.yaml', 'dist/speed-top.yaml'];
const MIN_PROXIES = Number(process.env.MIN_PROXIES || 100); // 低于这个数说明本轮抓取异常

// 公开产物里绝不能出现自己的凭据（域名/UUID/token）。aggregate 落盘前断言过一次，这里再验一次——
// publish 走的是 git，一旦漏出去就是公开仓库里的永久泄漏。
const 私有凭据 = /a5dea14ad4de58|97c109c4c7e4be|82bcf5b8|13c20322|d474812e|dingyue\.jiangjiangze\.icu|tl2?\.jiangjiangze\.icu/i;

const fail = (msg) => { console.error('✗ ' + msg); process.exitCode = 1; };
const ok = (msg) => console.log('✓ ' + msg);

// ---------- 1) 必须存在的产物 ----------
for (const f of ['dist/clash.yaml', 'dist/summary.json']) {
  if (!fs.existsSync(f)) fail(`缺少必需产物 ${f}`);
}

// ---------- 2) 结构校验 ----------
let total = 0;
for (const f of DIST) {
  if (!fs.existsSync(f)) continue;
  const text = fs.readFileSync(f, 'utf8');
  let doc;
  try { doc = yaml.load(text); } catch (e) { fail(`${f} YAML 解析失败: ${e.message}`); continue; }
  if (!Array.isArray(doc?.proxies)) { fail(`${f} 缺少 proxies 数组`); continue; }
  if (doc.proxies.length < MIN_PROXIES) { fail(`${f} 只有 ${doc.proxies.length} 个节点（< ${MIN_PROXIES}），疑似本轮抓取异常`); continue; }
  const 坏名 = doc.proxies.filter((p) => !p || !p.name || !p.type || !p.server || !p.port);
  if (坏名.length) { fail(`${f} 有 ${坏名.length} 个节点缺 name/type/server/port`); continue; }
  const 重名 = doc.proxies.length - new Set(doc.proxies.map((p) => p.name)).size;
  if (重名 > 0) fail(`${f} 有 ${重名} 个重名节点（内核会报 duplicate name）`);
  if (私有凭据.test(text)) { fail(`${f} 命中私有凭据，拒绝发布`); continue; }
  total = Math.max(total, doc.proxies.length);
  ok(`${f}: ${doc.proxies.length} 个节点，结构/去重/凭据检查通过`);
}

if (fs.existsSync('dist/summary.json')) {
  try {
    const s = JSON.parse(fs.readFileSync('dist/summary.json', 'utf8'));
    if (!s.generatedAt) fail('dist/summary.json 缺 generatedAt');
    else ok(`dist/summary.json: generatedAt=${s.generatedAt}`);
    if (私有凭据.test(JSON.stringify(s))) fail('dist/summary.json 命中私有凭据');
  } catch (e) { fail('dist/summary.json 不是合法 JSON: ' + e.message); }
}

// ---------- 3) 内核加载校验 ----------
const mihomo = process.env.MIHOMO_BIN || (fs.existsSync('./.mihomo-bin/mihomo') ? './.mihomo-bin/mihomo' : 'mihomo');
let hasMihomo = false;
try { execFileSync(mihomo, ['-v'], { stdio: 'pipe' }); hasMihomo = true; } catch { hasMihomo = false; }

if (!hasMihomo) {
  if (REQUIRE_MIHOMO) fail(`找不到 mihomo（${mihomo}），发布路径必须带内核校验`);
  else console.log('· 未找到 mihomo，跳过内核加载校验（仅结构校验）');
} else {
  for (const f of DIST) {
    if (!fs.existsSync(f)) continue;
    try {
      execFileSync(mihomo, ['-t', '-d', '.', '-f', f], { stdio: 'pipe', timeout: 180000 });
      ok(`${f}: mihomo -t 通过`);
    } catch (e) {
      const out = String(e.stdout || e.stderr || e.message).split('\n').slice(-6).join(' | ');
      fail(`${f}: mihomo -t 失败 → ${out}`);
    }
  }
}

console.log(`\n校验结束（最大节点数 ${total}）`);
if (process.exitCode) console.error('\n存在失败项，按门禁要求不应发布');
