// dom-collector.js — Reddit 搜索结果 DOM 收集器(跑在 chrome_cdp evaluate)。
// 2026 实测:Reddit 登录态 SSR 搜索页,帖子数据直接在 DOM 里(title/permalink/subreddit/ISO 时间/votes)。
// selector 策略(实测命中):
//   - 帖子链接:a[href*="/comments/"](在 <h2> 里)
//   - 容器:从链接往上找含 <time> 的祖先(textLen < 3000 的最大祖先)
//   - 时间:<time datetime="2026-07-02T...">ISO 时间戳
//   - votes/comments:容器 innerText 解析("2 votes·5 comments")
//   - author:列表页常无(要点进详情),留空
//   - selftext:列表页只有标题,无正文
//
// 安装 window.__redditCollector = { posts, seen, record }。
// scroll-and-collect.js 复用 record。
(() => {
  const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim();

  function extractPostFromLink(link) {
    const href = normalize(link.getAttribute('href') || '');
    if (!href || !href.includes('/comments/')) return null;
    const title = normalize(link.textContent || '');
    if (!title || title.length < 3) return null;

    // 往上找"单帖容器":含且仅含 1 个 <time>(单帖边界标志)。
    // 不取最大祖先(那会含多个帖子,导致 scoreText/subreddit 串台),取最近的单帖容器。
    let node = link;
    let best = null;
    for (let i = 0; i < 12 && node; i++) {
      const timeCount = node.querySelectorAll('time').length;
      const commentLinkCount = node.querySelectorAll('a[href*="/comments/"]').length;
      // 单帖容器:正好 1 个 time,且 comments 链接 ≤2(标题 + 可能的"X comments"按钮)
      if (timeCount === 1 && commentLinkCount <= 2) {
        best = node;
        break; // 取最近的(最精确的单帖边界)
      }
      node = node.parentElement;
    }
    // fallback:若没找到严格单帖,退到含 time 的最小祖先
    if (!best) {
      node = link;
      for (let i = 0; i < 10 && node; i++) {
        if (node.querySelector('time')) { best = node; break; }
        node = node.parentElement;
      }
    }
    if (!best) best = link.parentElement;
    if (!best) return null;

    const timeEl = best.querySelector('time');
    const postedAt = timeEl?.getAttribute('datetime') || '';
    // subreddit 从 permalink 自身解析(最可靠,不依赖页面其它 /r/ 链接)
    const permalinkMatch = href.match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
    const subredditFromPermalink = permalinkMatch ? permalinkMatch[1] : '';
    const authorLink = best.querySelector('a[href*="/user/"]');
    const author = authorLink?.getAttribute('href') || '';

    // permalink 规范化
    const permalink = permalinkMatch ? `/r/${permalinkMatch[1]}/comments/${permalinkMatch[2]}/` : href;

    return {
      permalink,
      title,
      subreddit: subredditFromPermalink, // 从 permalink 解析,不串台
      postedAt,
      author: author.match(/\/user\/([^/?]+)/)?.[1] || '',
      scoreText: best.innerText || '',
      bodyText: '',
    };
  }

  window.__redditCollector = window.__redditCollector || {
    posts: [],
    seen: {},
    record() {
      let added = 0;
      const links = document.querySelectorAll('a[href*="/comments/"]');
      for (const link of links) {
        // 只取 <h2> 里的链接(主标题,避免重复抓 footer/comment 链接)
        const inHeading = link.closest('h1, h2, h3');
        if (!inHeading) continue;
        const post = extractPostFromLink(link);
        if (!post || !post.permalink) continue;
        if (this.seen[post.permalink]) continue;
        this.seen[post.permalink] = true;
        this.posts.push(post);
        added++;
      }
      return { added, total: this.posts.length };
    },
    reset() {
      this.posts = [];
      this.seen = {};
    },
  };

  return {
    href: location.href,
    title: document.title,
    onLogin: !/log\s*in|sign\s*in/i.test(document.title || ''),
    blocked: /429|captcha|challenge|blocked/i.test(document.title || ''),
    initial: window.__redditCollector.record(),
    totalPosts: window.__redditCollector.posts.length,
  };
})()
