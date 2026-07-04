// dom-collector.js — LinkedIn 内容搜索结果的 DOM 收集器。
// 跑在 Chrome 页面内(chrome_cdp evaluate)。从旧的 collectVisiblePosts 主进程逻辑迁移:
//   - 作者链接定位(/in/ 或 /company/)
//   - URL 三级优先级:/feed/update/ > /posts/-activity- > 内部链接,最后作者链接兜底
//   - safety/go 外链包装解码(只保留 LinkedIn 域)
//   - 作者名回退:logo-only 公司账号从正文开头提取
//   - 相对时间标签解析(多语言:分钟/小时/天/周/月)
//   - 去重(authorHandle|postedAtLabel|url)
// 安装 window.__linkedinCollector = { rows, seen, record }。scroll-and-collect.js 复用。
(() => {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const toAbsoluteUrl = (value) => {
    try { return new URL(String(value || ''), location.origin).toString(); }
    catch { return ''; }
  };
  const findRelativeTimeLabel = (text) => {
    const patterns = [
      /\d+\s*(?:分钟|分|mins?|minutes?)(?!\S)/i,
      /\d+\s*(?:小时|hrs?|hours?)(?!\S)/i,
      /\d+\s*(?:天|days?)(?!\S)/i,
      /\d+\s*(?:周|weeks?|w)(?!\S)/i,
      /\d+\s*(?:个月|月|months?|mos?)(?!\S)/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return normalize(match[0]);
    }
    return '';
  };
  const normalizeAuthorText = (text) => {
    const compact = normalize(text);
    if (!compact) return '';
    return compact
      .split(/\d+\s*(?:分钟|分|mins?|minutes?|小时|hrs?|hours?|天|days?|周|weeks?|w|个月|月|months?|mos?)/i)[0]
      .split('•')[0]
      .trim();
  };
  const cleanCardText = (text) =>
    normalize(text)
      .replace(/^信息流动态\s*/u, '')
      .replace(/\s*赞 评论 转发 发送$/u, '')
      .trim();
  const pickContainer = (anchor) => {
    let node = anchor;
    let fallback = anchor.parentElement || anchor;
    for (let depth = 0; depth < 8 && node; depth += 1) {
      const text = normalize(node.innerText || node.textContent || '');
      if (text.length >= 40) fallback = node;
      if (
        text.length >= 160 &&
        text.length <= 2200 &&
        (text.includes('信息流动态') || text.includes('赞 评论 转发 发送'))
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return fallback;
  };
  const isInternalLink = (h) => {
    if (!h) return false;
    return h.startsWith('/') ||
      h.startsWith('https://www.linkedin.com/') ||
      h.startsWith('https://linkedin.com/');
  };

  // 重置收集器(每次搜索页调用一次)
  window.__linkedinCollector = {
    rows: [],
    seen: {},
    recordVisible() {
      let added = 0;
      if (location.pathname.includes('/login')) {
        return { added: 0, loginRequired: true };
      }
      for (const anchor of document.querySelectorAll('a[href]')) {
        const href = normalize(anchor.getAttribute('href') || '');
        const isAuthorLink = href.includes('/in/') || href.includes('/company/');
        if (!isAuthorLink) continue;
        const anchorText = normalize(anchor.innerText || anchor.textContent || '');
        let anchorTimeLabel = findRelativeTimeLabel(anchorText);
        if (!anchorTimeLabel && anchor.parentElement) {
          const parentText = normalize(anchor.parentElement.textContent || '');
          anchorTimeLabel = findRelativeTimeLabel(parentText);
        }
        const likelyPrimaryAuthorLink = Boolean(anchorTimeLabel) || href.includes('/posts/');
        if (!likelyPrimaryAuthorLink) continue;

        const container = pickContainer(anchor);
        const text = cleanCardText(container?.innerText || container?.textContent || '');
        if (!text || text.length < 80) continue;

        const linkCandidates = Array.from(container.querySelectorAll('a[href]'));
        const authorLink =
          linkCandidates.find((node) => {
            const candidate = String(node.getAttribute('href') || '').trim();
            return candidate.includes('/in/') || candidate.includes('/company/');
          }) || anchor;
        const authorHandle = normalize(authorLink?.getAttribute('href') || href);
        const authorName = normalizeAuthorText(authorLink?.innerText || anchor?.innerText || '');
        const finalAuthorName = authorName || text
          .split(/\d+\s*(?:分钟|分|mins?|minutes?|小时|hrs?|hours?|天|days?|周|weeks?|w|个月|月|months?|mos?)/i)[0]
          .split('•')[0]
          .replace(/\s*(?:访问网站|关注|加为好友|已关注)\s*/g, '')
          .trim();
        const postedAtLabel = findRelativeTimeLabel(text);
        if (!postedAtLabel) continue;

        // URL 三级优先级
        let sourceLink =
          linkCandidates.find((node) => {
            const candidate = String(node.getAttribute('href') || '').trim();
            return candidate.includes('/feed/update/');
          }) || null;
        if (!sourceLink) {
          sourceLink =
            linkCandidates.find((node) => {
              const candidate = String(node.getAttribute('href') || '').trim();
              return candidate.includes('/posts/') && /-activity-/.test(candidate);
            }) || null;
        }
        if (!sourceLink) {
          sourceLink =
            linkCandidates.find((node) => {
              const candidate = String(node.getAttribute('href') || '').trim();
              if (!candidate) return false;
              if (candidate.includes('/in/') || candidate.includes('/company/')) return false;
              if (candidate.includes('/search/')) return false;
              return isInternalLink(candidate);
            }) || null;
        }
        let resultUrl = sourceLink ? toAbsoluteUrl(sourceLink.getAttribute('href') || '') : '';

        // safety/go 外链包装解码(只保留 LinkedIn 域)
        if (resultUrl && resultUrl.includes('/safety/go/')) {
          try {
            const parsed = new URL(resultUrl);
            const encodedUrl = parsed.searchParams.get('url');
            if (encodedUrl) {
              const decoded = decodeURIComponent(encodedUrl);
              if (
                decoded.startsWith('https://www.linkedin.com/') ||
                decoded.startsWith('https://linkedin.com/') ||
                decoded.startsWith('https://lnkd.in/')
              ) {
                resultUrl = decoded;
              } else {
                resultUrl = '';
              }
            }
          } catch (_e) { /* 保留 safety/go 作 fallback */ }
        }
        if (!resultUrl) resultUrl = toAbsoluteUrl(href);

        const dedupeKey = `${authorHandle}|${postedAtLabel}|${resultUrl}`;
        if (window.__linkedinCollector.seen[dedupeKey]) continue;
        window.__linkedinCollector.seen[dedupeKey] = true;

        window.__linkedinCollector.rows.push({
          postedAt: '',
          postedAtLabel,
          url: resultUrl,
          content: text,
          authorHandle,
          authorName: finalAuthorName,
        });
        added++;
      }
      return { added, visibleAuthors: document.querySelectorAll('a[href*="/in/"], a[href*="/company/"]').length };
    },
  };

  const initial = window.__linkedinCollector.recordVisible();
  return {
    href: location.href,
    title: document.title,
    initial,
    totalRows: window.__linkedinCollector.rows.length,
    loginRequired: initial.loginRequired === true,
  };
})()
