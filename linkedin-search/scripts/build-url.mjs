#!/usr/bin/env node
// build-url.mjs — 确定性构造 LinkedIn 内容搜索 URL(最新排序 + 时间档位)。
// worker 用 bash 调它,拿到完整 URL 直接 navigate,不自己拼(避免漏 sortBy/datePosted 参数)。
// 用法:node build-url.mjs --keyword "<keyword>" --dateRange <past-24h|past-week|past-month>

function argValue(name) {
  const args = process.argv.slice(2);
  const flag = `--${name}`;
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const prefix = `${flag}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

const keyword = argValue('keyword');
const dateRange = argValue('dateRange');

if (!keyword.trim()) {
  console.error(JSON.stringify({ ok: false, error: 'keyword is required' }));
  process.exit(2);
}

// LinkedIn 原生只支持三档。dispatcher 已归并,这里再校验一次(确定性兜底)。
const VALID_TIERS = ['past-24h', 'past-week', 'past-month'];
const tier = VALID_TIERS.includes(dateRange) ? dateRange : 'past-week'; // 兜底默认一周

const url =
  'https://www.linkedin.com/search/results/content/' +
  `?keywords=${encodeURIComponent(keyword)}` +
  '&origin=FACETED_SEARCH' +
  '&sortBy=%5B%22date_posted%22%5D' +
  `&datePosted=%5B%22${tier}%22%5D`;

// stdout 只输出 URL(worker 直接拿用)。stderr 不污染。
console.log(url);
