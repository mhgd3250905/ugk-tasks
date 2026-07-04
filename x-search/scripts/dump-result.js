// dump-result.js — 分块读取 window.__xSearcherLastResult 的全量行。
// worker 循环 evaluate 它(offset += limit),每次返回一块紧凑数据。
// worker 把每块 append 进同一个 $TASK_OUTPUT_DIR 文件 —— 完整原文,不截断。
// ponytail: 这是数据从 Chrome 页面到 worker 的唯一通道(CDP evaluate 返回值)。
// 分块只为避免单次返回值过大,不是为了省上下文(worker 是一次性进程,退出即销毁)。
(() => {
  const config = window.__xSearcherDumpConfig || {};
  const result = window.__xSearcherLastResult || null;
  if (!result) {
    return { ok: false, error: 'no_xSearcherLastResult', hint: 'run anchor-scroll.js first' };
  }

  const source = config.source === 'allRows' ? 'allRows' : 'rows';
  const rows = Array.isArray(result[source]) ? result[source] : [];
  const offset = Math.max(0, Number.isFinite(Number(config.offset)) ? Number(config.offset) : 0);
  const requestedLimit = Number.isFinite(Number(config.limit)) ? Number(config.limit) : 50;
  const limit = Math.max(1, Math.min(100, requestedLimit));

  const chunk = rows.slice(offset, offset + limit).map((row, index) => ({
    index: offset + index,
    postedAt: row.postedAt || '',
    url: row.url || '',
    content: String(row.content || ''),
    authorName: row.authorName || '',
    authorHandle: row.authorHandle || '',
  }));

  return {
    ok: true,
    keyword: result.keyword || '',
    rangeLabel: result.rangeLabel || '',
    cutoff: result.cutoff || '',
    href: result.href || location.href,
    source,
    totalRows: rows.length,
    offset,
    limit,
    returned: chunk.length,
    hasMore: offset + chunk.length < rows.length,
    rows: chunk,
  };
})()
