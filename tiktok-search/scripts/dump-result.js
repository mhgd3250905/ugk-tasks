// dump-result.js — 分块读取 window.__tiktokCollector.rows 的全量结果。
// worker 循环 evaluate 它(offset += limit),每次返回一块,worker 累积写文件。
// 范式同 x-search 的 dump-result.js。
(() => {
  const config = window.__tiktokDumpConfig || {};
  const rows = (window.__tiktokCollector && Array.isArray(window.__tiktokCollector.rows))
    ? window.__tiktokCollector.rows
    : [];
  const offset = Math.max(0, Number.isFinite(Number(config.offset)) ? Number(config.offset) : 0);
  const requestedLimit = Number.isFinite(Number(config.limit)) ? Number(config.limit) : 50;
  const limit = Math.max(1, Math.min(100, requestedLimit));

  const chunk = rows.slice(offset, offset + limit).map((row, index) => ({
    index: offset + index,
    url: row.url || '',
    author: row.author || '',
    desc: String(row.desc || ''),
    hashtags: Array.isArray(row.hashtags) ? row.hashtags : [],
    createTime: Number(row.createTime) || 0,
    likeCount: Number(row.likeCount) || 0,
  }));

  return {
    ok: true,
    href: location.href,
    totalRows: rows.length,
    offset,
    limit,
    returned: chunk.length,
    hasMore: offset + chunk.length < rows.length,
    rows: chunk,
  };
})()
