#!/usr/bin/env node
// build-url.mjs — 确定性构造 Instagram 关键词搜索 URL(CLI 包装)。
// worker 用 bash 调它,拿到 URL 直接 navigate,不自己拼(避免编码错)。
// 用法:node build-url.mjs --keyword "<keyword>"
//
// URL 构造的纯函数 + 校验逻辑在 filter-lib.mjs(buildInstagramSearchUrl,带空校验 throw),
// 这里只是 CLI 包装 + 单测可独立测纯函数。

import { fileURLToPath } from 'node:url';
import { buildInstagramSearchUrl } from './filter-lib.mjs';

export { buildInstagramSearchUrl }; // re-export,便于从此处 import

function argValue(name) {
  const args = process.argv.slice(2);
  const flag = `--${name}`;
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const prefix = `${flag}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

// CLI 入口(仅当作为主模块运行时执行,被 import 时不跑)
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const keyword = argValue('keyword');
  try {
    console.log(buildInstagramSearchUrl(keyword));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exit(2);
  }
}
