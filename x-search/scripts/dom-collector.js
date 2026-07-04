(() => {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function extractArticle(article) {
    const timeEl = article.querySelector('time');
    const postedAt = normalize(timeEl?.getAttribute('datetime') || '');
    const linkEl = article.querySelector('a[href*="/status/"]');
    const href = normalize(linkEl?.getAttribute('href') || '');
    if (!postedAt || !href) return null;

    let url = '';
    try { url = new URL(href, location.origin).toString(); } catch { return null; }
    if (!/\/status\/\d+/.test(url)) return null;

    const content = normalize(
      Array.from(article.querySelectorAll('[data-testid="tweetText"]'))
        .map((node) => node.textContent || '')
        .join(' '),
    );
    if (!content) return null;

    const pathMatch = new URL(url).pathname.match(/^\/([^/]+)\/status\//);
    const spans = Array.from(article.querySelectorAll('div[dir="ltr"] span'))
      .map((node) => normalize(node.textContent || ''))
      .filter(Boolean);

    return {
      postedAt,
      url,
      content,
      authorHandle: pathMatch ? `@${pathMatch[1]}` : '',
      authorName: spans.find((text) => !text.startsWith('@')) || '',
    };
  }

  const configuredMaxRows = Number(
    window.__xSearcherCollectorConfig?.maxRows
    ?? window.__xSearcherRunConfig?.collectorMaxRows
    ?? 1000,
  );
  const maxRows = Math.max(50, Math.min(5000, Number.isFinite(configuredMaxRows) ? configuredMaxRows : 1000));

  window.__xSearcherDom = {
    rows: [],
    seen: {},
    mutationCount: 0,
    startedAt: new Date().toISOString(),
    scrollBatches: [],
    maxRows,
    droppedRows: 0,
    limitReached: false,
  };

  window.__xSearcherRecordArticle = (article, source = 'unknown') => {
    const row = extractArticle(article);
    if (!row || window.__xSearcherDom.seen[row.url]) return false;
    window.__xSearcherDom.seen[row.url] = true;
    if (window.__xSearcherDom.rows.length >= window.__xSearcherDom.maxRows) {
      window.__xSearcherDom.droppedRows++;
      window.__xSearcherDom.limitReached = true;
      return false;
    }
    window.__xSearcherDom.rows.push({ ...row, firstSeenAt: new Date().toISOString(), source });
    return true;
  };

  window.__xSearcherRecordVisible = (source = 'visible') => {
    let added = 0;
    for (const article of document.querySelectorAll('article')) {
      if (window.__xSearcherRecordArticle(article, source)) added++;
    }
    return { added, visibleArticles: document.querySelectorAll('article').length };
  };

  if (window.__xSearcherObserver) window.__xSearcherObserver.disconnect();
  window.__xSearcherObserver = new MutationObserver((mutations) => {
    window.__xSearcherDom.mutationCount += mutations.length;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.('article')) window.__xSearcherRecordArticle(node, 'mutation');
        for (const article of node.querySelectorAll?.('article') || []) {
          window.__xSearcherRecordArticle(article, 'mutation');
        }
      }
    }
  });
  window.__xSearcherObserver.observe(document.body, { childList: true, subtree: true });

  const initial = window.__xSearcherRecordVisible('initial');
  return {
    href: location.href,
    title: document.title,
    scrollY: window.scrollY,
    initial,
    totalRows: window.__xSearcherDom.rows.length,
    maxRows: window.__xSearcherDom.maxRows,
    droppedRows: window.__xSearcherDom.droppedRows,
    limitReached: window.__xSearcherDom.limitReached,
    mutationCount: window.__xSearcherDom.mutationCount,
  };
})()
