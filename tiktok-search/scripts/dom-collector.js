// dom-collector.js — TikTok 搜索结果的 DOM 收集器。
// 跑在 Chrome 页面内(chrome_cdp evaluate)。负责两个职能:
//   1. clickRetryButtons:点击页面上的失败重试按钮(「重试/Retry/Refresh」),防 lazy-load 卡住
//   2. collectVisibleVideos:从 [data-e2e="search_top-item"] 卡片提取视频信息
//      - url: /video/<id> 链接
//      - author: 从 /@user/video/ 提
//      - desc: 从 img[alt] 提(去掉 "created by X" 后缀)
//      - hashtags: # 标签
//      - createTime: 从 [data-e2e="search-card-desc"] 的 DivTimeTag 解析(epoch sec)
//      - likeCount: 卡片内 <strong> 的数字
//
// 安装 window.__tiktokCollector = { rows, seen, collect, clickRetryButtons }
// grid-scroll.js 复用。
//
// 从源 skill clickRetryButtons + collectVisibleVideos 迁移,改成常驻 collector。
(() => {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  // === 日期标签解析(页面内 inline 版,和 filter-lib.mjs 的 parseTikTokDateTag 同逻辑)===
  function parseDateTag(text) {
    const trimmed = normalize(text).toLowerCase().replace(/\s+/g, '');
    if (!trimmed) return 0;
    const nowSec = Math.floor(Date.now() / 1000);

    const relMatch = trimmed.match(/^(\d+)(y|mo|w|d|h|m)ago$/);
    if (relMatch) {
      const num = Number(relMatch[1]);
      const unit = relMatch[2];
      switch (unit) {
        case 'y': return nowSec - num * 31536000;
        case 'mo': return nowSec - num * 2592000;
        case 'w': return nowSec - num * 604800;
        case 'd': return nowSec - num * 86400;
        case 'h': return nowSec - num * 3600;
        case 'm': return nowSec - num * 60;
        default: return 0;
      }
    }
    let match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (!Number.isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
    }
    match = trimmed.match(/^(\d{1,2})-(\d{1,2})$/);
    if (match) {
      const now = new Date();
      const month = Number(match[1]) - 1;
      const day = Number(match[2]);
      let year = now.getFullYear();
      const d = new Date(year, month, day);
      if (d > now) { year -= 1; d.setFullYear(year); }
      if (!Number.isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
    }
    return 0;
  }

  // === 点击失败重试按钮 ===
  function clickRetryButtons() {
    let clicked = 0;
    const retryPatterns = /重试|retry|refresh|重新加载|再试一次|try again|something went wrong|加载失败/i;
    const candidates = document.querySelectorAll('button, [role="button"], div[class*="error"], div[class*="retry"], div[class*="fail"]');
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (retryPatterns.test(text) && text.length < 50) {
        try {
          el.scrollIntoView({ block: 'center' });
          el.click();
          clicked += 1;
        } catch (_) { /* skip unclickable */ }
      }
    }
    if (clicked === 0) {
      const closeButtons = document.querySelectorAll('[aria-label*="close" i], [aria-label*="关闭"], [aria-label*="dismiss" i]');
      for (const btn of closeButtons) {
        const parent = btn.closest('[class*="error"], [class*="retry"], [class*="fail"], [class*="modal"]');
        if (parent) {
          try { btn.click(); clicked += 1; } catch (_) {}
        }
      }
    }
    return clicked;
  }

  // === 从可见卡片收集视频 ===
  function collectVisibleVideos() {
    const rows = [];
    const seen = window.__tiktokCollector?.seen || {};
    const cards = document.querySelectorAll('[data-e2e="search_top-item"]');

    for (const card of cards) {
      const linkEl = card.querySelector('a[href*="/video/"]');
      const href = normalize(linkEl?.getAttribute('href') || '');
      if (!href) continue;
      let url = '';
      try { url = new URL(href, location.origin).toString(); } catch { continue; }
      if (!/\/video\/\d+/.test(url)) continue;
      if (seen[url]) continue;
      seen[url] = true;

      // author 从 /@user/video/ 提
      let author = '';
      const authorMatch = href.match(/\/@?([^/]+)\/video\//);
      if (authorMatch) author = authorMatch[1];

      // desc 从 img[alt] 提,去掉 "created by X" 后缀
      const imgEl = card.querySelector('img[alt]');
      const altText = normalize(imgEl?.getAttribute('alt') || '');
      let desc = altText;
      const createdByIdx =
        altText.search(/\bcreated by\b/i) >= 0 ? altText.search(/\bcreated by\b/i)
        : altText.search(/\b-\s*medtrum\b/i) >= 0 ? altText.search(/\b-\s*medtrum\b/i)
        : -1;
      if (createdByIdx >= 0) desc = altText.slice(0, createdByIdx).trim();

      const hashMatch = desc.match(/#\S+/g);
      const hashtags = hashMatch ? hashMatch.map((h) => h.replace(/^#/, '')) : [];
      const descClean = desc.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim();
      const finalDesc = descClean || (createdByIdx >= 0 ? altText.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim() : altText);

      // 时间:从 search-card-desc 的 DivTimeTag 提
      const container = card.parentElement;
      let createTime = 0;
      if (container) {
        const descCard = container.querySelector('[data-e2e="search-card-desc"]');
        if (descCard) {
          const timeTag = descCard.querySelector('[class*="DivTimeTag"]');
          if (timeTag) createTime = parseDateTag(timeTag.textContent || '');
        }
      }

      // 点赞:卡片内 <strong> 的数字
      let likeCount = 0;
      for (const el of card.querySelectorAll('strong')) {
        const t = normalize(el.textContent || '');
        const m = t.match(/^([\d.]+)\s*([kKmM]?)$/);
        if (m) {
          const n = parseFloat(m[1]);
          if (!Number.isNaN(n)) {
            const v = m[2].toLowerCase() === 'k' ? Math.round(n * 1000)
                    : m[2].toLowerCase() === 'm' ? Math.round(n * 1000000)
                    : Math.round(n);
            if (v > likeCount) likeCount = v;
          }
        }
      }

      rows.push({ url, author, desc: finalDesc, hashtags, createTime, likeCount });
    }
    return rows;
  }

  window.__tiktokCollector = {
    rows: [],
    seen: {},
    clickRetryButtons: () => clickRetryButtons(),
    collect: () => {
      const fresh = collectVisibleVideos();
      for (const row of fresh) {
        window.__tiktokCollector.rows.push(row);
      }
      return { collected: fresh.length, total: window.__tiktokCollector.rows.length };
    },
    reset: () => {
      window.__tiktokCollector.rows = [];
      window.__tiktokCollector.seen = {};
    },
  };

  return {
    href: location.href,
    title: document.title,
    onLogin: /log\s*in|login/i.test(document.title || ''),
    blocked: /429|captcha|challenge/i.test(document.title || ''),
    collectorReady: true,
  };
})()
