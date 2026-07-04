// scroll-and-collect.js — Reddit 搜索页滚动主循环(页面内长 evaluate)。
// Reddit 用无限滚动加载更多帖子(滚到底自动加载下一批)。
// 滚动容器:document.documentElement(window.scrollBy)+ 偶尔有内部容器
// 停止:连续 maxStale 轮无新帖 → bottom_reached
//
// config 从 window.__redditScrollConfig 读:{ maxRounds: 30, maxStale: 5, maxPosts: 200 }
// dom-collector.js 必须先装好。resolve 返回摘要(全量在 window.__redditCollector.posts)。
new Promise((resolve) => {
  const config = window.__redditScrollConfig || {};
  const maxRounds = Number.isFinite(Number(config.maxRounds)) ? Number(config.maxRounds) : 30;
  const maxStale = Number.isFinite(Number(config.maxStale)) ? Number(config.maxStale) : 5;
  const maxPosts = Number.isFinite(Number(config.maxPosts)) ? Number(config.maxPosts) : 200;
  const renderWaitMs = 2500;
  const scrollStepMs = 150;

  const runStartPerf = performance.now();
  let round = 0;
  let staleCount = 0;
  let prevHeight = document.documentElement.scrollHeight;
  let stoppedReason = 'max_rounds';

  if (!window.__redditCollector || typeof window.__redditCollector.record !== 'function') {
    resolve({ ok: false, error: 'collector_not_installed', hint: 'install dom-collector.js first' });
    return;
  }

  function finish() {
    resolve({
      ok: true,
      stoppedReason,
      rounds: round,
      totalPosts: window.__redditCollector.posts.length,
      totalRunMs: Math.round(performance.now() - runStartPerf),
    });
  }

  function doRound() {
    if (round >= maxRounds) { stoppedReason = 'max_rounds'; return finish(); }
    if (window.__redditCollector.posts.length >= maxPosts) { stoppedReason = 'max_posts_reached'; return finish(); }
    round++;

    // 平滑滚动到底(window.scrollBy,几小步)
    const stepCount = 5;
    const totalDelta = Math.max(400, window.innerHeight * 0.8);
    let step = 0;
    function scrollStep() {
      if (step >= stepCount) {
        setTimeout(() => {
          // 收集本轮可见
          const rec = window.__redditCollector.record();
          const newHeight = document.documentElement.scrollHeight;
          const nearBottom = window.scrollY + window.innerHeight >= newHeight - 100;

          if (newHeight === prevHeight && rec.added === 0) {
            staleCount++;
          } else {
            staleCount = 0;
            prevHeight = newHeight;
          }

          if (staleCount >= maxStale) {
            stoppedReason = 'bottom_reached';
            return finish();
          }
          setTimeout(doRound, 200);
        }, renderWaitMs);
        return;
      }
      window.scrollBy(0, Math.ceil(totalDelta / stepCount));
      step++;
      setTimeout(scrollStep, scrollStepMs);
    }
    scrollStep();
  }

  doRound();
})
