// dump-result.js — 分块读取 window.__redditCollector.posts 的全量结果。
// worker 循环 evaluate 它(offset += limit),每次返回一块。
(() => {
  const config = window.__redditDumpConfig || {};
  const posts = (window.__redditCollector && Array.isArray(window.__redditCollector.posts))
    ? window.__redditCollector.posts
    : [];
  const offset = Math.max(0, Number.isFinite(Number(config.offset)) ? Number(config.offset) : 0);
  const requestedLimit = Number.isFinite(Number(config.limit)) ? Number(config.limit) : 50;
  const limit = Math.max(1, Math.min(100, requestedLimit));

  const chunk = posts.slice(offset, offset + limit).map((p, i) => ({
    index: offset + i,
    permalink: p.permalink || '',
    title: p.title || '',
    subreddit: p.subreddit || '',
    postedAt: p.postedAt || '',
    author: p.author || '',
    scoreText: p.scoreText || '',
    bodyText: p.bodyText || '',
  }));

  return {
    ok: true,
    href: location.href,
    totalPosts: posts.length,
    offset,
    limit,
    returned: chunk.length,
    hasMore: offset + chunk.length < posts.length,
    posts: chunk,
  };
})()
