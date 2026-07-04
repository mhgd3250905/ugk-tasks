// dump-result.js — 分块读取 window.__insCollector 的全量已发现帖子链接。
// worker 循环 evaluate 它(offset += limit),每次返回一块,worker 把每块 append 进文件。
// 范式同 x-search 的 dump-result.js。
//
// 注意:ins-search 的全量结果是"已发现的帖子链接"(还要逐个 navigate 取详情)。
// 帖子详情是 worker 导航到每个帖子页后用 dom-collector.extractPostDetail() 取的,
// 不在这个 dump 里 —— 这个 dump 只给 worker "要 navigate 哪些帖子"的清单。
(() => {
  const config = window.__insDumpConfig || {};
  const posts = window.__insCollector && window.__insCollector.discoveredPosts
    ? Array.from(window.__insCollector.discoveredPosts.values())
    : [];
  const offset = Math.max(0, Number.isFinite(Number(config.offset)) ? Number(config.offset) : 0);
  const requestedLimit = Number.isFinite(Number(config.limit)) ? Number(config.limit) : 50;
  const limit = Math.max(1, Math.min(100, requestedLimit));

  // 按发现时间排序(近期优先),无时间的排后(稳定排序)
  const sorted = [...posts].sort((a, b) => {
    const aMs = typeof a.discoveredAtMs === 'number' ? a.discoveredAtMs : -Infinity;
    const bMs = typeof b.discoveredAtMs === 'number' ? b.discoveredAtMs : -Infinity;
    return bMs - aMs;
  });

  const chunk = sorted.slice(offset, offset + limit).map((item, index) => ({
    index: offset + index,
    postUrl: item.postUrl || '',
    matchedBy: item.matchedBy || '',
    discoveredAtMs: item.discoveredAtMs || null,
  }));

  return {
    ok: true,
    href: location.href,
    totalDiscovered: sorted.length,
    offset,
    limit,
    returned: chunk.length,
    hasMore: offset + chunk.length < sorted.length,
    posts: chunk,
  };
})()
