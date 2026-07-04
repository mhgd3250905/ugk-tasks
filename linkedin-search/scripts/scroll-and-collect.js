// scroll-and-collect.js — LinkedIn 搜索页滚动采集主循环(页面内长 evaluate)。
// 从旧的 collectPosts 主进程逻辑迁移到页面内:滚动 + 收集 + 停止判断全在一个长 evaluate 里。
// LinkedIn 定制方案(必须保留):
//   - 滚动容器优先级:#workspace > main > overflow 元素 > window(LinkedIn 用容器滚动,不是 window)
//   - 无限滚动(小步随机 20-40%)+ 按钮点击(25% 概率点"加载更多/Show more")双策略
//   - bounce 反爬:到底+无新内容时,先上滚再下滚触发懒加载
//   - 停止:连续 4 轮 stale+到底(经 bounce 仍未加载)→ bottom_reached
// config 从 window.__linkedinRunConfig 读(keyword/startIso/endIso/maxScrolls 等)。
// 全量结果存 window.__linkedinCollector.rows(dom-collector 已装好)。resolve 返回摘要 + 预览。
new Promise((resolve) => {
  const config = window.__linkedinRunConfig || {};
  // LinkedIn 已在服务端按 datePosted 过滤时间范围,worker 该做的是把过滤后的结果全部滚出来。
  // 所以不再用 maxScrolls 做截断 —— 它只是防无限循环的安全上限。真正停止靠"到底"判断。
  const hardCap = 200; // 纯安全上限,防异常页面无限循环。正常停止不靠它。
  const runStartPerf = performance.now();
  const startedAt = new Date().toISOString();

  // 相对时间标签 → ms(多语言)。inline 实现(dom-collector 用的相同 patterns)
  function parseLabelToMs(label, nowMs) {
    const MINUTE_MS = 60 * 1000, HOUR_MS = 60 * MINUTE_MS, DAY_MS = 24 * HOUR_MS;
    const normalized = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized) return null;
    const absParsed = Date.parse(normalized);
    if (Number.isFinite(absParsed)) return absParsed;
    const patterns = [
      { pattern: /(\d+)\s*(?:分钟|分|mins?|minutes?)/i, unitMs: MINUTE_MS },
      { pattern: /(\d+)\s*(?:小时|hrs?|hours?)/i, unitMs: HOUR_MS },
      { pattern: /(\d+)\s*(?:天|days?)/i, unitMs: DAY_MS },
      { pattern: /(\d+)\s*(?:周|weeks?|w)(?!\S)/i, unitMs: 7 * DAY_MS },
      { pattern: /(\d+)\s*(?:个月|月|months?|mos?)(?!\S)/i, unitMs: 30 * DAY_MS },
    ];
    for (const entry of patterns) {
      const match = normalized.match(entry.pattern);
      if (!match) continue;
      const count = Number.parseInt(match[1], 10);
      if (Number.isFinite(count) && count >= 0) return nowMs - count * entry.unitMs;
    }
    return null;
  }

  function scrollAndTryLoadMore() {
    let container = document.querySelector('#workspace') || document.querySelector('main');
    let useWindowScroll = false;
    if (!container || container.scrollHeight <= container.clientHeight + 10 || getComputedStyle(container).overflowY === 'visible') {
      const docEl = document.documentElement;
      if (docEl.scrollHeight > docEl.clientHeight + 10) useWindowScroll = true;
    }
    if (!useWindowScroll && !container) {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const style = getComputedStyle(el);
        if ((style.overflowY === 'scroll' || style.overflowY === 'auto') && el.scrollHeight > el.clientHeight + 50) {
          container = el;
          break;
        }
      }
    }
    const docEl = document.documentElement;
    const randomStepRatio = 0.2 + Math.random() * 0.2;
    let scrolled = 0;
    let buttonClicked = false;
    if (useWindowScroll) {
      const before = window.scrollY;
      const step = Math.max(200, Math.floor(window.innerHeight * randomStepRatio));
      window.scrollBy(0, step);
      scrolled = window.scrollY - before;
    } else if (container) {
      const before = container.scrollTop;
      const step = Math.max(200, Math.floor(container.clientHeight * randomStepRatio));
      container.scrollTop = Math.min(container.scrollTop + step, container.scrollHeight - container.clientHeight);
      scrolled = container.scrollTop - before;
    }
    if (Math.random() < 0.25) {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (text === '加载更多' || text === 'Show more results' || text === '查看更多结果') {
          btn.scrollIntoView({ block: 'center' });
          btn.click();
          buttonClicked = true;
          break;
        }
      }
    }
    return { scrolled, buttonClicked };
  }

  function getMetrics() {
    const c = document.querySelector('#workspace') || document.querySelector('main');
    if (c && c.scrollHeight > c.clientHeight + 10 && getComputedStyle(c).overflowY !== 'visible') {
      return { scrollH: c.scrollHeight, clientH: c.clientHeight, scrollTop: c.scrollTop };
    }
    const docEl = document.documentElement;
    return { scrollH: docEl.scrollHeight, clientH: window.innerHeight, scrollTop: window.scrollY };
  }

  function bounceScroll() {
    const c = document.querySelector('#workspace') || document.querySelector('main');
    const upPx = Math.floor((window.innerHeight || 700) * (0.3 + Math.random() * 0.2));
    if (c && c.scrollHeight > c.clientHeight + 10 && getComputedStyle(c).overflowY !== 'visible') {
      c.scrollTop = Math.max(0, c.scrollTop - upPx);
    } else {
      window.scrollBy(0, -upPx);
    }
  }
  function bounceScrollDown() {
    const c = document.querySelector('#workspace') || document.querySelector('main');
    const downPx = Math.floor((window.innerHeight || 700) * (0.4 + Math.random() * 0.2));
    if (c && c.scrollHeight > c.clientHeight + 10 && getComputedStyle(c).overflowY !== 'visible') {
      c.scrollTop = Math.min(c.scrollTop + downPx, c.scrollHeight - c.clientHeight);
    } else {
      window.scrollBy(0, downPx);
    }
  }

  const nowMs = Date.now();
  let prevScrollH = 0;
  let consecutiveStale = 0;
  let totalButtonClicks = 0;
  let actualRounds = 0;
  let stoppedReason = 'max_rounds';
  let loginRequired = false;

  function finish() {
    const totalRunMs = Math.round(performance.now() - runStartPerf);
    const all = window.__linkedinCollector?.rows || [];
    resolve({
      ok: !loginRequired,
      keyword: config.keyword || '',
      stoppedReason,
      loginRequired,
      totalRows: all.length,
      scrollStatus: {
        actualRounds,
        stoppedReason,
        totalDiscovered: all.length,
        buttonClicks: totalButtonClicks,
      },
      startedAt,
      endedAt: new Date().toISOString(),
      totalRunMs,
      rows: all.slice(0, 50), // 预览(worker 全量用 dump-result 分块取)
    });
  }

  function doRound() {
    if (actualRounds >= hardCap) { stoppedReason = 'safety_cap_reached'; return finish(); }
    actualRounds++;

    const rowsBefore = window.__linkedinCollector?.rows?.length || 0;
    const scrollResult = scrollAndTryLoadMore();
    if (scrollResult.buttonClicked) totalButtonClicks++;

    const waitMs = scrollResult.buttonClicked
      ? (2500 + Math.random() * 1500)
      : (1000 + Math.random() * 1500);

    setTimeout(() => {
      // 收集本轮可见
      const rec = window.__linkedinCollector?.recordVisible?.() || {};
      if (rec.loginRequired) { loginRequired = true; stoppedReason = 'login_required'; return finish(); }

      const metrics = getMetrics();
      const rowsAfter = window.__linkedinCollector?.rows?.length || 0;
      const newRows = rowsAfter - rowsBefore;
      const scrollStale = metrics.scrollH === prevScrollH;
      const nearBottom = metrics.scrollTop + metrics.clientH >= metrics.scrollH - 50;

      // 核心到底判断:双信号 —— 页面高度停滞 AND 没有新帖被收集。
      // 单看 scrollHeight 不够(LinkedIn 虚拟列表会让高度波动);单看新帖也不够(加载延迟)。
      // 两个都 stale 才算一轮"无进展"。
      const noProgress = scrollStale && newRows === 0;

      if (noProgress && nearBottom && !scrollResult.buttonClicked) {
        // bounce:上滚 → 等待 → 下滚 → 等待 → 重新检查双信号
        bounceScroll();
        setTimeout(() => {
          bounceScrollDown();
          setTimeout(() => {
            const recheckRows = window.__linkedinCollector?.rows?.length || 0;
            const recheckMetrics = getMetrics();
            const bouncedNew = recheckRows - rowsAfter;
            const bouncedStale = recheckMetrics.scrollH === prevScrollH;
            // bounce 后:有新帖 OR 高度增长 → 还有内容,重置继续滚
            if (bouncedNew > 0 || !bouncedStale) {
              prevScrollH = recheckMetrics.scrollH;
              consecutiveStale = 0;
              setTimeout(doRound, 200);
              return;
            }
            consecutiveStale++;
            // 连续 5 轮(含 bounce)双信号都无进展 → 真到底了
            if (consecutiveStale >= 5) { stoppedReason = 'bottom_reached'; return finish(); }
            prevScrollH = metrics.scrollH;
            setTimeout(doRound, 200);
          }, 1500 + Math.random() * 1500);
        }, 1500 + Math.random() * 1500);
      } else {
        // 有进展(高度增长 或 有新帖 或 还没到底)→ 重置 stale 计数,继续滚
        consecutiveStale = 0;
        prevScrollH = metrics.scrollH;
        setTimeout(doRound, 200);
      }
    }, waitMs);
  }

  if (!window.__linkedinCollector || typeof window.__linkedinCollector.recordVisible !== 'function') {
    return resolve({ ok: false, error: 'collector_not_installed', hint: 'install dom-collector.js first' });
  }
  doRound();
})
