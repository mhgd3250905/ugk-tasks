#!/usr/bin/env node
// build-url.mjs — 确定性构造 TikTok 搜索 URL(CLI 包装)。
// worker 用 bash 调它,拿到 URL 直接 navigate,不自己拼。
// 用法:node build-url.mjs --keyword "<keyword>"
//
// 纯函数 buildTikTokSearchUrl 在 filter-lib.mjs,这里只是 CLI 包装。

import { fileURLToPath } from 'node:url';
import { buildTikTokSearchUrl } from './filter-lib.mjs';

export { buildTikTokSearchUrl };

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
  try {
    console.log(buildTikTokSearchUrl(keyword));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exit(2);
  }
}
