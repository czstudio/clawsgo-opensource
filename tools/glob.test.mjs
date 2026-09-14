// globToRegex 的回归测试：确保 `**/*` 能匹配根目录文件、`*.csv` 只匹配当前层。
// 这是曾经的线上 bug —— 替换顺序错误导致生成的正则谁都匹配不上。
import assert from 'node:assert/strict';

// 与 server/lib/workspace.mjs 中同名函数保持逐字一致
function globToRegex(glob) {
  const esc = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\?/g, '[^/]')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${esc}$`);
}

const all = globToRegex('**/*');
for (const p of [
  'README.md',
  'data/raw/20260301_S1.csv',
  'scripts/humidity_expose.py',
  '.clawsgo/figures/efficiency_vs_anneal.md',
]) {
  assert.ok(all.test(p), `**/* 应匹配 ${p}`);
}

const shallow = globToRegex('*.csv');
assert.ok(shallow.test('a.csv'), '*.csv 应匹配 a.csv');
assert.ok(!shallow.test('data/b.csv'), '*.csv 不应匹配 data/b.csv');

const nested = globToRegex('data/**/*.csv');
assert.ok(nested.test('data/raw/x.csv'), 'data/**/*.csv 应匹配 data/raw/x.csv');
assert.ok(!nested.test('scripts/x.csv'), 'data/**/*.csv 不应匹配 scripts/x.csv');

const single = globToRegex('data/?.csv');
assert.ok(single.test('data/a.csv'), 'data/?.csv 应匹配 data/a.csv');
assert.ok(!single.test('data/ab.csv'), 'data/?.csv 不应匹配 data/ab.csv');

console.log('globToRegex 回归测试通过');
