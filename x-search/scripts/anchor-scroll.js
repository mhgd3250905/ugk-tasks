// anchor-scroll.js — X Latest DOM 收集 + anchor-overlap 滚动。
// 跑在 Chrome 页面内(chrome_cdp evaluate),负责把虚拟化 timeline 的推文抓全。
// resolve 返回摘要 + 预览(小,不撑 worker 上下文);全量定型的结果存 window.__xSearcherLastResult。
// 落地(写文件)是 worker 的活,不在这里做 —— 见 skill.md 的 dump 分块流程。
new Promise((resolve) => {
  const runStartedAt = new Date().toISOString();
  const runStartPerf = performance.now();
  const config = window.__xSearcherRunConfig || {};
  const keyword = String(config.keyword || '').trim();
  const cutoff = new Date(config.startIso || config.cutoffIso || Date.now() - 30 * 24 * 60 * 60 * 1000);
  const configuredEnd = new Date(config.endIso || Date.now() + 5 * 60 * 1000);
  const windowEnd = Number.isNaN(configuredEnd.getTime()) ? new Date(Date.now() + 5 * 60 * 1000) : configuredEnd;
  const maxSteps = Number.isFinite(Number(config.maxSteps)) ? Number(config.maxSteps) : 20;
  const returnRowsLimit = Number.isFinite(Number(config.returnRowsLimit)) ? Number(config.returnRowsLimit) : 50;
  const configuredCollectorMaxRows = Number(config.collectorMaxRows ?? 1000);
  const collectorMaxRows = Math.max(50, Math.min(5000, Number.isFinite(configuredCollectorMaxRows) ? configuredCollectorMaxRows : 1000));
  const batches = [];
  let stepNo = 0;
  let noNewStreak = 0;
  let olderStreak = 0;
  let stagnantStreak = 0;

  function visibleStatusPaths() {
    return [...document.querySelectorAll('article a[href*="/status/"]')]
      .map((a) => {
        try { return new URL(a.getAttribute('href'), location.origin).pathname; }
        catch { return ''; }
      })
      .filter(Boolean);
  }

  function currentVisibleDates() {
    return [...document.querySelectorAll('article time')]
      .map((time) => new Date(time.getAttribute('datetime') || ''))
      .filter((date) => !Number.isNaN(date.getTime()));
  }

  function hasKeyword(row) {
    if (!keyword) return true;
    return `${row.content} ${row.authorName} ${row.authorHandle}`
      .toLowerCase()
      .includes(keyword.toLowerCase());
  }

  function classifyXProblem() {
    const text = document.body?.innerText || '';
    if (/Log in|Sign in/i.test(text)) return 'login_wall';
    if (/rate limit|try again later/i.test(text)) return 'rate_limited';
    if (/Something went wrong|Try reloading/i.test(text)) return 'x_error';
    if (/No results/i.test(text)) return 'empty_timeline';
    return '';
  }

  function doStep() {
    const stepStartPerf = performance.now();
    if (!window.__xSearcherDom || !window.__xSearcherRecordVisible) {
      return finish('collector_not_installed');
    }
    window.__xSearcherDom.maxRows = collectorMaxRows;
    if (window.__xSearcherDom.rows.length >= collectorMaxRows) window.__xSearcherDom.limitReached = true;
    if (window.__xSearcherDom.limitReached) return finish('collector_limit');

    const before = window.__xSearcherDom.rows.length;
    const preRecordStartPerf = performance.now();
    const pre = window.__xSearcherRecordVisible('pre-anchor-scroll');
    const preRecordMs = Math.round(performance.now() - preRecordStartPerf);
    const anchorFindStartPerf = performance.now();
    const articles = [...document.querySelectorAll('article')]
      .filter((article) => article.querySelector('time') && article.querySelector('a[href*="/status/"]'));
    const beforePaths = visibleStatusPaths();

    const anchorIndex = Math.max(0, articles.length - 3);
    const anchorFindMs = Math.round(performance.now() - anchorFindStartPerf);
    const anchor = articles[anchorIndex] || articles[articles.length - 1];
    if (!anchor) return finish('no_anchor');

    const anchorLink = anchor.querySelector('a[href*="/status/"]');
    let anchorPath = '';
    try { anchorPath = new URL(anchorLink?.getAttribute('href') || '', location.origin).pathname; } catch {}

    const yBefore = window.scrollY;
    const scrollCallStartPerf = performance.now();
    anchor.scrollIntoView({ block: 'start', inline: 'nearest' });
    const scrollCallMs = Math.round(performance.now() - scrollCallStartPerf);

    const settleStartPerf = performance.now();
    const started = Date.now();
    let lastSignature = '';
    let stableTicks = 0;
    let stableChecks = 0;

    function tick() {
      window.__xSearcherRecordVisible('post-anchor-scroll');
      const afterPaths = visibleStatusPaths();
      const current = afterPaths.join('|');
      if (current && current === lastSignature) stableTicks++;
      else stableTicks = 0;
      lastSignature = current;
      stableChecks++;

      if (stableTicks >= 2 || Date.now() - started > 6500) {
        const settleMs = Math.round(performance.now() - settleStartPerf);
        const finalRecordStartPerf = performance.now();
        const dates = currentVisibleDates();
        const allOlderVisible = dates.length > 0 && dates.every((date) => date < cutoff);
        const added = window.__xSearcherDom.rows.length - before;
        const yAfter = window.scrollY;
        const overlapCount = beforePaths.filter((path) => afterPaths.includes(path)).length;
        const finalRecordMs = Math.round(performance.now() - finalRecordStartPerf);

        if (added === 0) noNewStreak++;
        else noNewStreak = 0;
        if (allOlderVisible) olderStreak++;
        else olderStreak = 0;
        if (Math.abs(yAfter - yBefore) < 5 && added === 0) stagnantStreak++;
        else stagnantStreak = 0;

        const batch = {
          step: stepNo,
          totalStepMs: Math.round(performance.now() - stepStartPerf),
          preRecordMs, anchorFindMs, scrollCallMs, settleMs, stableChecks, finalRecordMs,
          yBefore: Math.round(yBefore), yAfter: Math.round(yAfter), movedBy: Math.round(yAfter - yBefore),
          preAdded: pre.added, added,
          totalRows: window.__xSearcherDom.rows.length,
          visibleArticles: document.querySelectorAll('article').length,
          anchorIndex, anchorPath, overlapCount, allOlderVisible,
          noNewStreak, olderStreak, stagnantStreak,
        };
        batches.push(batch);
        window.__xSearcherDom.scrollBatches = batches;
        stepNo++;

        const xProblem = classifyXProblem();
        if (xProblem) return finish(xProblem);
        if (window.__xSearcherDom.limitReached) return finish('collector_limit');
        if (olderStreak >= 3) return finish('cutoff_reached');
        if (stepNo >= maxSteps) return finish('max_steps');
        if (noNewStreak >= 3) return finish('no_new_posts');
        if (stagnantStreak >= 2) return finish('stagnant_anchor');
        return setTimeout(doStep, 500);
      }
      return setTimeout(tick, 700);
    }

    setTimeout(tick, 900);
  }

  function finish(stopReason) {
    window.__xSearcherRecordVisible?.('final');
    const all = window.__xSearcherDom?.rows || [];
    const valid = all.filter((row) => {
      const date = new Date(row.postedAt);
      return !Number.isNaN(date.getTime()) && /\/status\/\d+/.test(row.url || '') && String(row.content || '').trim();
    });
    const rows = valid
      .filter((row) => {
        const posted = new Date(row.postedAt);
        return posted >= cutoff && posted < windowEnd && hasKeyword(row);
      })
      .sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));
    const dates = valid
      .map((row) => new Date(row.postedAt))
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((a, b) => a - b);
    const oldest = dates[0] || null;
    const cutoffReached = stopReason === 'cutoff_reached' || Boolean(oldest && oldest <= cutoff);
    const validRate = all.length ? valid.length / all.length : 0;
    const keywordMatchRate = rows.length ? rows.filter(hasKeyword).length / rows.length : 1;
    const overlapGood = batches.length
      ? batches.filter((batch) => batch.overlapCount >= 1 || batch.anchorPath).length / batches.length
      : 0;
    const collectorHealthy = Boolean(window.__xSearcherDom && window.__xSearcherRecordVisible && all.length > 0);
    const stopQuality = stopReason === 'cutoff_reached' ? 10
      : stopReason === 'no_new_posts' ? 6
      : stopReason === 'max_steps' ? 4
      : stopReason === 'collector_limit' ? 3
      : 0;
    const score = Math.round(
      (cutoffReached ? 20 : stopReason === 'max_steps' ? 10 : 0) +
      15 +
      (overlapGood >= 0.8 ? 15 : overlapGood > 0 ? 8 : 0) +
      (collectorHealthy ? 15 : 0) +
      stopQuality +
      Math.round(10 * validRate) +
      Math.round(10 * keywordMatchRate) +
      5
    );
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : 'D';

    const runEndedAt = new Date().toISOString();
    const totalRunMs = Math.round(performance.now() - runStartPerf);

    // ponytail: 全量定型结果存页面,供 worker 后续分块 dump(见 dump-result.js)。
    // worker 上下文只收下面的摘要 + 预览,不收全量,避免撑爆。
    window.__xSearcherLastResult = {
      ok: !['collector_not_installed', 'login_wall', 'rate_limited', 'x_error'].includes(stopReason),
      keyword,
      rangeLabel: config.rangeLabel || '',
      now: runEndedAt,
      cutoff: cutoff.toISOString(),
      windowStart: cutoff.toISOString(),
      windowEnd: windowEnd.toISOString(),
      endExclusive: true,
      href: location.href,
      title: document.title,
      stopReason,
      cutoffReached,
      anchorScrolls: batches.length,
      maxSteps,
      rowsInspected: all.length,
      validRows: valid.length,
      filteredRows: rows.length,
      validRate,
      keywordMatchRate,
      mutationCount: window.__xSearcherDom?.mutationCount || 0,
      collectorMaxRows: window.__xSearcherDom?.maxRows || collectorMaxRows,
      droppedRows: window.__xSearcherDom?.droppedRows || 0,
      collectorLimitReached: Boolean(window.__xSearcherDom?.limitReached),
      overlapGood,
      score,
      grade,
      runStartedAt,
      runEndedAt,
      totalRunMs,
      batches,
      rows,        // 过滤后的全量(范围内 + 关键词命中),dump 取这个
      allRows: all, // 全量原始(含范围外/未命中),按需 dump
    };

    // resolve 回 worker 的只是摘要 + 预览。小,上下文友好。
    resolve({
      ok: window.__xSearcherLastResult.ok,
      keyword,
      rangeLabel: config.rangeLabel || '',
      now: runEndedAt,
      cutoff: cutoff.toISOString(),
      windowStart: cutoff.toISOString(),
      windowEnd: windowEnd.toISOString(),
      endExclusive: true,
      href: location.href,
      title: document.title,
      stopReason,
      cutoffReached,
      anchorScrolls: batches.length,
      maxSteps,
      rowsInspected: all.length,
      validRows: valid.length,
      filteredRows: rows.length,
      validRate,
      keywordMatchRate,
      mutationCount: window.__xSearcherLastResult.mutationCount,
      collectorMaxRows,
      droppedRows: window.__xSearcherLastResult.droppedRows,
      collectorLimitReached: window.__xSearcherLastResult.collectorLimitReached,
      overlapGood,
      score,
      grade,
      runStartedAt,
      runEndedAt,
      totalRunMs,
      returnRowsLimit,
      batches,
      rowsReturned: Math.min(rows.length, returnRowsLimit),
      rowsTruncated: rows.length > returnRowsLimit,
      rows: rows.slice(0, returnRowsLimit),
    });
  }

  doStep();
})
