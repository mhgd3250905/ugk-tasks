// scroll-and-collect.js — LinkedIn 搜索页滚动采集主循环(页面内长 evaluate)。
// 从旧的 collectPosts 主进程逻辑迁移到页面内:滚动 + 收集 + 停止判断全在一个长 evaluate 里。
// LinkedIn 定制方案(必须保留):
//   - 滚动容器优先级:#workspace > main > overflow 元素 > window(LinkedIn 用容器滚动,不是 window)
//   - 无限滚动(小步随机 20-40%)+ 按钮点击(25% 概率点"加载更多/Show more")双策略
//   - bounce 反爬:到底+无新内容时,先上滚再下滚触发懒加载
//   - 停止:bottom_reached 为主(滚到底),hardCap/maxRows 为纯安全网(防异常死循环)
//
// ⚠️ 设计原则(用户明确要求):LinkedIn 已服务端按 datePosted 过滤,worker 的职责是
//    把过滤后的结果**全部滚出来**(滚到底),不要用 maxRows/hardCap 提前截断。
//    past-month 内容多时可能需要 100+ 轮(实测 117 轮收 47 条属正常)。
//    hardCap=300 / maxRows=500 是极端安全网,正常情况不应触发(触发说明页面异常)。
// config 从 window.__linkedinRunConfig 读(keyword/maxRows/hardCap 等)。
// 全量结果存 window.__linkedinCollector.rows(dom-collector 已装好)。resolve 返回摘要 + 预览。
new Promise((resolve) => {
  const config = window.__linkedinRunConfig || {};
  // 默认值放得很宽:正常靠 bottom_reached 停,这两个只在页面异常死循环时兜底。
  const maxRows = Number.isFinite(Number(config.maxRows)) ? Number(config.maxRows) : 500;
  const hardCap = Number.isFinite(Number(config.hardCap)) ? Number(config.hardCap) : 300;
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
      { pattern: /(\d+)\s*(?:分钟|分|mins?|minutes?|m)/i, unitMs: MINUTE_MS },
      { pattern: /(\d+)\s*(?:小时|hrs?|hours?|h)/i, unitMs: HOUR_MS },
      { pattern: /(\d+)\s*(?:天|days?|d)/i, unitMs: DAY_MS },
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
    // maxRows 兜底:LinkedIn 持续加载时,达到上限主动停(不追求绝对全量,够用即可)
    const currentRows = window.__linkedinCollector?.rows?.length || 0;
    if (currentRows >= maxRows) { stoppedReason = 'max_rows_reached'; return finish(); }
    actualRounds++;

    const rowsBefore = currentRows;
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
      // ponytail: scrollStale 用容差(±20px),不用严格 ===。LinkedIn 虚拟列表到底时
      // scrollHeight 仍有 ±几像素波动(虚拟 DOM 回收/重建),严格相等永远 false →
      // noProgress 永远不成立 → 死循环到 hardCap/超时(实测 5 分钟超时才停,但已到底)。
      const scrollStale = Math.abs(metrics.scrollH - prevScrollH) <= 20;
      const nearBottom = metrics.scrollTop + metrics.clientH >= metrics.scrollH - 50;

      // 核心到底判断:两个独立信号任一连续命中即算无进展 ——
      //   (a) 高度停滞(容差)且无新帖:scrollStale && newRows===0
      //   (b) 已到底(nearBottom)且无新帖:nearBottom && newRows===0
      // 单看 scrollHeight 不够(波动);单看新帖不够(加载延迟);单看 nearBottom 不够(中间也有 nearBottom 假象)。
      // 但"到底 + 无新帖"是强信号,不该被 scrollHeight 波动否决。
      const noProgressByHeight = scrollStale && newRows === 0;
      const noProgressAtBottom = nearBottom && newRows === 0;
      const noProgress = noProgressByHeight || noProgressAtBottom;

      if (noProgress && nearBottom && !scrollResult.buttonClicked) {
        // bounce:上滚 → 等待 → 下滚 → 等待 → 重新检查双信号
        bounceScroll();
        setTimeout(() => {
          bounceScrollDown();
          setTimeout(() => {
            const recheckRows = window.__linkedinCollector?.rows?.length || 0;
            const recheckMetrics = getMetrics();
            const bouncedNew = recheckRows - rowsAfter;
            const bouncedStale = Math.abs(recheckMetrics.scrollH - prevScrollH) <= 20;
            const bouncedNearBottom = recheckMetrics.scrollTop + recheckMetrics.clientH >= recheckMetrics.scrollH - 50;
            // bounce 后:有新帖 OR 高度增长(超容差)OR 不在底 → 还有内容,重置继续滚
            if (bouncedNew > 0 || (!bouncedStale && !bouncedNearBottom)) {
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
        // 有进展(高度增长超容差 或 有新帖 或 还没到底)→ 重置 stale 计数,继续滚
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
