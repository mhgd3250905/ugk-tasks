#!/usr/bin/env node
// build-url.mjs — 确定性构造 Reddit 搜索 URL(CLI 包装)。
// Reddit 搜索 URL: https://www.reddit.com/search/?q=KEYWORD&sort=new&t=TIME_RANGE
// t 参数是 Reddit 原生时间档位:hour/day/week/month/year/all
// 用法:node build-url.mjs --keyword "<keyword>" --timeRange <hour|day|week|month|year|all>
import { fileURLToPath } from 'node:url';
import { buildRedditSearchUrl } from './filter-lib.mjs';
export { buildRedditSearchUrl };

function argValue(name) {
  const args = process.argv.slice(2);
  const flag = `--${name}`;
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const prefix = `${flag}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const keyword = argValue('keyword');
  const timeRange = argValue('timeRange') || 'week';
  try {
    console.log(buildRedditSearchUrl(keyword, timeRange));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exit(2);
  }
}
