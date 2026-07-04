// seed-scroll.js — Instagram 种子页平滑滚动主循环(页面内长 evaluate)。
// 跑在 chrome_cdp evaluate 里,负责把单个种子页(关键词页/hashtag/用户主页)的帖子链接滚全。
//
// IG 关键定制(必须保留,源自 ins_search_latest.mjs 的实战经验):
//   - 滚动容器是 <html>(overflow: scroll),window.scrollBy 即可
//   - 平滑渐进滚动(5 小步 × 200ms,共 ~400px/轮),不用单次跳底 —— IG 无限滚动需要渐进触发
//   - 每轮等 2.5s 让新内容渲染
//   - 最多 8 轮,连续 4 轮无新链接 → 停(noNewLimit)
//
// config 从 window.__insSeedScrollConfig 读:
//   { postsPerSeed: 36, maxRounds: 8, noNewLimit: 4, scrollDelta: 400, matchedBy: 'keyword_search' }
// dom-collector.js 必须先装好(提供 scanSeedLinks + addDiscovered)。
// resolve 返回本轮种子扫描的摘要(不返回全量链接 —— 全量在 window.__insCollector.discoveredPosts)。
new Promise((resolve) => {
  const config = window.__insSeedScrollConfig || {};
  const maxRounds = Number.isFinite(Number(config.maxRounds)) ? Number(config.maxRounds) : 8;
  const noNewLimit = Number.isFinite(Number(config.noNewLimit)) ? Number(config.noNewLimit) : 4;
  const postsPerSeed = Number.isFinite(Number(config.postsPerSeed)) ? Number(config.postsPerSeed) : 36;
  const scrollDelta = Number.isFinite(Number(config.scrollDelta)) ? Number(config.scrollDelta) : 400;
  const matchedBy = String(config.matchedBy || 'keyword_search');
  const chunkDelayMs = 200;
  const renderWaitMs = 2500;
  const stepCount = 5;

  const runStartPerf = performance.now();
  let round = 0;
  let noNewRounds = 0;
  let seedLinkCount = 0;
  let stoppedReason = 'max_rounds';

  if (!window.__insCollector || typeof window.__insCollector.scanSeedLinks !== 'function') {
    resolve({ ok: false, error: 'collector_not_installed', hint: 'install dom-collector.js first' });
    return;
  }

  function finish() {
    resolve({
      ok: true,
      matchedBy,
      rounds: round,
      stoppedReason,
      seedLinkCount,
      totalDiscovered: window.__insCollector.discoveredPosts.size,
      totalRunMs: Math.round(performance.now() - runStartPerf),
    });
  }

  function doRound() {
    if (round >= maxRounds) {
      stoppedReason = 'max_rounds';
      return finish();
    }
    if (seedLinkCount >= postsPerSeed) {
      stoppedReason = 'posts_per_seed_reached';
      return finish();
    }
    round++;

    // 平滑渐进滚动:5 小步 × 200ms,触发 IG 无限加载
    let step = 0;
    function scrollStep() {
      if (step >= stepCount) {
        // 等渲染,然后扫描
        setTimeout(() => {
          const snapshot = window.__insCollector.scanSeedLinks(postsPerSeed);
          let newCount = 0;
          for (const link of snapshot) {
            if (window.__insCollector.addDiscovered(link, matchedBy, link.label)) {
              newCount++;
            }
          }
          seedLinkCount += newCount;

          if (seedLinkCount >= postsPerSeed) {
            stoppedReason = 'posts_per_seed_reached';
            return finish();
          }
          if (newCount === 0) {
            noNewRounds++;
            if (noNewRounds >= noNewLimit) {
              stoppedReason = 'no_new_links';
              return finish();
            }
          } else {
            noNewRounds = 0;
          }
          setTimeout(doRound, 200);
        }, renderWaitMs);
        return;
      }
      window.scrollBy(0, Math.ceil(scrollDelta / stepCount));
      step++;
      setTimeout(scrollStep, chunkDelayMs);
    }
    scrollStep();
  }

  doRound();
})
