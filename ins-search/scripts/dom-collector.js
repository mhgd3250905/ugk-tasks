// dom-collector.js — Instagram 搜索结果的 DOM 收集器。
// 跑在 Chrome 页面内(chrome_cdp evaluate)。负责两个职能:
//   1. seed-scan:在种子页(关键词页/hashtag/用户主页)从 a[href] 提取 /p/ /reel/ /tv/ 帖子链接
//   2. post-detail:导航到帖子详情页后,从 <script type="application/ld+json"> 提取结构化数据
//
// 安装 window.__insCollector = { discoveredPosts: Map, seenUrls: Set, recordSeedLinks, extractPostDetail }
// seed-scroll.js 复用 recordSeedLinks;worker 导航到详情页后调 extractPostDetail。
//
// 从源 skill buildSeedScanExpression + buildPostExtractionExpression 迁移,
// 改成常驻 collector(不用每次重新 inject 表达式)。
(() => {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  const POST_LINK_RE = /^\/(?:[^/]+\/)?(p|reel|tv)\//;

  // ===== seed-scan:从种子页 a[href] 抽帖子链接 =====
  function scanSeedLinks(limit) {
    const links = [];
    const seen = new Set();
    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href') || '';
      if (!href) continue;
      let url;
      try {
        url = new URL(href, location.href);
      } catch {
        continue;
      }
      if (!POST_LINK_RE.test(url.pathname)) continue;
      url.hash = '';
      url.search = '';
      const absolute = url.toString();
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      const label =
        anchor.getAttribute('aria-label') ||
        anchor.getAttribute('title') ||
        anchor.querySelector('img')?.getAttribute('alt') ||
        anchor.textContent ||
        '';
      links.push({
        url: absolute,
        label: clean(label),
      });
      if (links.length >= limit) break;
    }
    return links;
  }

  // ===== post-detail:从 ld+json + OG meta 抽帖子结构化数据 =====
  // 2026 实测:IG 已移除 <script type="application/ld+json">,OG description 是唯一结构化源。
  // 真实 OG 格式:`"6 likes, 1 comments -  medtrumofficial，December 12, 2025 : \"caption\". "`
  // 策略:ld+json 先试(兼容 IG 可能回退);空则从 OG 解析(parseOgDescription 逻辑 inline)。
  function parseOgInline(raw) {
    const text = String(raw || '').trim();
    if (!text) return { author: '', caption: '', postedAt: '', likeCount: null, commentCount: null };
    const likeMatch = text.match(/(\d[\d,]*)\s+likes?/i);
    const commentMatch = text.match(/(\d[\d,]*)\s+comments?/i);
    const authorMatch = text.match(/-\s+([^\s,，：:][^,，：]*?)\s*[,，：:]/);
    const captionMatch = text.match(/[""]([\s\S]*?)[""]\s*\.?\s*$/);
    let postedAt = '';
    if (authorMatch) {
      const afterAuthor = text.slice(authorMatch.index + authorMatch[0].length);
      const dateInTail = afterAuthor.match(/^\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})\s*:/);
      if (dateInTail) postedAt = dateInTail[1].trim();
      else {
        const dateSeg = afterAuthor.match(/^\s*([^:]+?)\s*:/);
        if (dateSeg && !dateSeg[1].includes('"')) postedAt = dateSeg[1].trim();
      }
    }
    return {
      author: authorMatch ? authorMatch[1].trim() : '',
      caption: captionMatch ? captionMatch[1].trim() : '',
      postedAt,
      likeCount: likeMatch ? Number.parseInt(likeMatch[1].replace(/[^\d]/g, ''), 10) : null,
      commentCount: commentMatch ? Number.parseInt(commentMatch[1].replace(/[^\d]/g, ''), 10) : null,
    };
  }

  function extractPostDetail() {
    const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);
    const parseJson = (raw) => {
      try { return JSON.parse(raw); } catch { return null; }
    };
    const flatten = (node) => {
      if (!node || typeof node !== 'object') return [];
      if (Array.isArray(node)) return node.flatMap(flatten);
      const graph = Array.isArray(node['@graph']) ? node['@graph'].flatMap(flatten) : [];
      return [node, ...graph];
    };

    const ldNodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .flatMap((script) => flatten(parseJson(script.textContent || '')));
    const primary =
      ldNodes.find((node) => {
        const types = asArray(node['@type']).map((v) => String(v));
        return types.some((t) =>
          ['SocialMediaPosting', 'ImageObject', 'VideoObject', 'Article'].includes(t),
        );
      }) || {};

    const metaDescription = clean(
      document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '',
    );
    // OG 解析(2026 主路径,因 ld+json 已失效)
    const og = parseOgInline(metaDescription);

    const getInteractionCount = (targetType) => {
      const stats = asArray(primary.interactionStatistic);
      for (const stat of stats) {
        const type = clean(
          stat?.interactionType?.['@type'] || stat?.interactionType?.name || stat?.name,
        );
        if (!type.toLowerCase().includes(targetType.toLowerCase())) continue;
        const count = Number(stat?.userInteractionCount);
        if (Number.isFinite(count)) return count;
      }
      return null;
    };

    // 字段:ld+json 优先(若 IG 回退),OG 兜底(当前主路径)
    const author = clean(
      primary.author?.alternateName ||
        primary.author?.name ||
        document.querySelector('header a[href^="/"]')?.textContent ||
        '',
    ) || og.author;
    const postedAt = clean(
      primary.uploadDate ||
        primary.datePublished ||
        primary.dateCreated ||
        document.querySelector('time')?.getAttribute('datetime') ||
        '',
    ) || og.postedAt;
    // caption:ld+json articleBody 优先,否则 OG caption,否则 OG 全文(去元数据)
    const ldCaption = clean(primary.articleBody || primary.caption || primary.description || primary.name || '');
    const caption = (ldCaption && ldCaption !== metaDescription) ? ldCaption : (og.caption || '');
    const commentCount = Number.isFinite(Number(primary.commentCount))
      ? Number(primary.commentCount)
      : (getInteractionCount('comment') ?? og.commentCount);
    const likeCount = getInteractionCount('like') ?? og.likeCount;

    return {
      url: location.href,
      author,
      postedAt,
      caption,
      likeCount,
      commentCount,
      metaDescription,
      redirectedToLogin: location.pathname.includes('/accounts/login'),
      visibleTextExcerpt: clean(document.body ? document.body.innerText : '').slice(0, 500),
    };
  }

  // ===== 收集器状态 =====
  window.__insCollector = window.__insCollector || {
    discoveredPosts: new Map(), // postUrl → { postUrl, matchedBy, discoveredAtMs }
    scanSeedLinks: (limit = 36) => scanSeedLinks(limit),
    extractPostDetail: () => extractPostDetail(),
    addDiscovered: (link, matchedBy, label) => {
      const key = link.url;
      if (window.__insCollector.discoveredPosts.has(key)) return false;
      // 解析 label 里的日期(用于排序优先级),解析不出留 null
      let discoveredAtMs = null;
      const normalized = String(label || '').replace(/\s+/g, ' ').trim();
      if (normalized) {
        const englishAbsolute = normalized.match(/\b(?:on\s+)?([A-Z][a-z]+ \d{1,2}, \d{4})\b/);
        if (englishAbsolute) {
          const parsed = Date.parse(englishAbsolute[1]);
          if (Number.isFinite(parsed)) discoveredAtMs = parsed;
        }
        if (discoveredAtMs === null) {
          const relDays = normalized.match(/(\d+)\s*(?:days?|天)前?/i);
          if (relDays) {
            const d = Number.parseInt(relDays[1], 10);
            if (Number.isFinite(d)) discoveredAtMs = Date.now() - d * 24 * 60 * 60 * 1000;
          }
        }
      }
      window.__insCollector.discoveredPosts.set(key, {
        postUrl: link.url,
        matchedBy,
        discoveredAtMs,
      });
      return true;
    },
    reset: () => {
      window.__insCollector.discoveredPosts = new Map();
    },
  };

  return {
    href: location.href,
    title: document.title,
    onLogin: location.pathname.includes('/accounts/login') || /log\s*in/i.test(document.title || ''),
    collectorReady: true,
  };
})()
