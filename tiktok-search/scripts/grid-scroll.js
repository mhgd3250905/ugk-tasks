// grid-scroll.js — TikTok 搜索页滚动主循环(页面内长 evaluate)。
// 跑在 chrome_cdp evaluate 里,负责把搜索结果卡片滚全。
//
// TikTok 关键定制(必须保留,源自 tiktok_search_latest.mjs 实战经验):
//   - 滚动容器是 <main id="grid-main">(不是 window/body!)
//   - 每轮开始前 clickRetryButtons(防 lazy-load 失败卡住 DOM)
//   - 平滑滚动:5 小步 × 200ms/轮
//   - 每轮等 3s 让卡片渲染
//   - 连续 noNewThreshold 轮无新卡片 → 停(默认 6,TikTok 分批加载需高容忍)
//   - 点了重试按钮的轮次不算 stale(给内容恢复机会)
//
// config 从 window.__tiktokScrollConfig 读:
//   { maxScrolls: 30, noNewThreshold: 6 }
// dom-collector.js 必须先装好。resolve 返回摘要(全量在 window.__tiktokCollector.rows)。
new Promise((resolve) => {
  const config = window.__tiktokScrollConfig || {};
  const maxScrolls = Number.isFinite(Number(config.maxScrolls)) ? Number(config.maxScrolls) : 30;
  const noNewThreshold = Number.isFinite(Number(config.noNewThreshold)) ? Number(config.noNewThreshold) : 6;
  const smoothChunks = 5;
  const chunkDelayMs = 200;
  const renderWaitMs = 3000;

  const runStartPerf = performance.now();
  const startedAt = new Date().toISOString();
  let step = 0;
  let noNewCount = 0;
  let prevScrollH = 0;
  let stoppedReason = 'max_scrolls';
  let totalRetriesClicked = 0;

  if (!window.__tiktokCollector || typeof window.__tiktokCollector.collect !== 'function') {
    resolve({ ok: false, error: 'collector_not_installed', hint: 'install dom-collector.js first' });
    return;
  }

  function getScrollInfo() {
    const grid = document.getElementById('grid-main');
    return grid
      ? { clientH: grid.clientHeight, scrollH: grid.scrollHeight, scrollTop: grid.scrollTop }
      : { clientH: window.innerHeight, scrollH: document.body.scrollHeight, scrollTop: window.scrollY };
  }

  function finish() {
    const all = window.__tiktokCollector.rows || [];
    resolve({
      ok: true,
      stoppedReason,
      actualScrolls: step,
      maxScrolls,
      totalRetriesClicked,
      totalCollected: all.length,
      scrollStatus: { actualScrolls: step, maxScrolls, stoppedReason },
      startedAt,
      endedAt: new Date().toISOString(),
      totalRunMs: Math.round(performance.now() - runStartPerf),
      preview: all.slice(0, 50),
    });
  }

  function doScroll() {
    if (step >= maxScrolls) {
      stoppedReason = 'max_scrolls';
      return finish();
    }
    step++;

    // 每轮开始:点重试按钮(防 lazy-load 卡住)
    const retriesClicked = window.__tiktokCollector.clickRetryButtons();
    totalRetriesClicked += retriesClicked;
    if (retriesClicked > 0) {
      // 点了重试按钮,多等一会
      setTimeout(() => doScrollInner(retriesClicked), 2000);
    } else {
      doScrollInner(0);
    }
  }

  function doScrollInner(retriesClickedThisRound) {
    const info = getScrollInfo();
    const scrollDeltaPerRound = Math.floor((info.clientH || 659) * 0.6);
    let chunk = 0;
    function scrollChunk() {
      if (chunk >= smoothChunks) {
        // 等渲染,然后收集
        setTimeout(() => afterRender(retriesClickedThisRound), renderWaitMs);
        return;
      }
      const grid = document.getElementById('grid-main');
      const delta = Math.ceil(scrollDeltaPerRound / smoothChunks);
      if (grid) grid.scrollTop += delta;
      else window.scrollBy(0, delta);
      chunk++;
      setTimeout(scrollChunk, chunkDelayMs);
    }
    scrollChunk();
  }

  function afterRender(retriesClickedThisRound) {
    const info = getScrollInfo();
    const newScrollH = info.scrollH || 0;

    if (newScrollH === prevScrollH) {
      noNewCount += 1;
    } else {
      prevScrollH = newScrollH;
      noNewCount = 0;
    }

    const rec = window.__tiktokCollector.collect();
    const newCount = rec.collected;

    if (newCount === 0 && noNewCount >= noNewThreshold) {
      // 最后挣扎:再点一次重试按钮
      const lastRetry = window.__tiktokCollector.clickRetryButtons();
      totalRetriesClicked += lastRetry;
      if (lastRetry > 0) {
        noNewCount = 0;
        setTimeout(() => doScrollInner(0), 3000);
        return;
      }
      stoppedReason = 'no_new_content';
      return finish();
    }

    if (newCount > 0) {
      noNewCount = 0;
    } else if (retriesClickedThisRound > 0) {
      // 点了重试但还没新内容,这轮不算 stale
      noNewCount = Math.max(0, noNewCount - 1);
    }

    setTimeout(doScroll, 200);
  }

  // 初始:先点一次重试按钮(页面初始可能是失败态)
  const initRetries = window.__tiktokCollector.clickRetryButtons();
  totalRetriesClicked += initRetries;
  if (initRetries > 0) {
    setTimeout(doScroll, 3000);
  } else {
    doScroll();
  }
})
