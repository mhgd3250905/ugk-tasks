// dump-result.js — 分块读取 window.__linkedinCollector.rows 的全量结果。
// worker 循环 evaluate 它(offset += limit),每次返回一块紧凑数据。
// worker 把每块 append 进同一个 $TASK_OUTPUT_DIR 文件 —— 完整原文,不截断。
// 范式同 x-search 的 dump-result.js,只是字段适配 LinkedIn。
(() => {
  const config = window.__linkedinDumpConfig || {};
  const rows = (window.__linkedinCollector && Array.isArray(window.__linkedinCollector.rows))
    ? window.__linkedinCollector.rows
    : [];
  const offset = Math.max(0, Number.isFinite(Number(config.offset)) ? Number(config.offset) : 0);
  const requestedLimit = Number.isFinite(Number(config.limit)) ? Number(config.limit) : 50;
  const limit = Math.max(1, Math.min(100, requestedLimit));

  const chunk = rows.slice(offset, offset + limit).map((row, index) => ({
    index: offset + index,
    postedAtLabel: row.postedAtLabel || '',
    postedAt: row.postedAt || '',
    url: row.url || '',
    content: String(row.content || ''),
    authorName: row.authorName || '',
    authorHandle: row.authorHandle || '',
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
