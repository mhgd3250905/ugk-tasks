import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// verify 只管"产物层语义校验":worker 是否按 contract 产出了有效结果。
// 输入层校验(required 字段存在/有效)由 dispatcher 门禁负责,这里不重复。
const failures = [];
function fail(assertion, expected, actual, hint) { failures.push({ assertion, expected, actual, hint }); }
function parseJsonText(text, label) {
  try { return JSON.parse(text); }
  catch (error) { fail(label + ' is valid JSON', 'parseable JSON', error.message || String(error)); return null; }
}
function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

const outDir = process.env.TASK_OUTPUT_DIR || '.';
const outputFile = join(outDir, 'linkedin_search_results.json');
const taskInput = parseJsonText(process.env.TASK_INPUT || '{}', 'TASK_INPUT') || {};
const keyword = String(taskInput.keyword ?? '');

if (!existsSync(outputFile)) {
  fail('output artifact exists', 'linkedin_search_results.json', 'missing', 'worker must write the main JSON artifact');
} else {
  const data = parseJsonText(readFileSync(outputFile, 'utf8'), 'linkedin_search_results.json');
  if (data) {
    // 顶层字段
    for (const field of ['platform', 'keyword', 'retrievedAt', 'queryUrl', 'timeWindow', 'benchmark', 'results']) {
      if (!(field in data)) fail('output has field ' + field, 'present', 'missing');
    }

    // platform 标识
    if (String(data.platform ?? '').toLowerCase() !== 'linkedin') {
      fail('platform is LinkedIn', 'LinkedIn', data.platform);
    }

    // keyword 契约(产物层:worker 是否用了正确 keyword)
    if (String(data.keyword ?? '') !== keyword) fail('keyword matches TASK_INPUT.keyword', keyword, data.keyword);

    // queryUrl 是 LinkedIn 内容搜索(产物语义)—— 必须含 sortBy + datePosted(由 build-url.mjs 生成)
    const url = String(data.queryUrl ?? '');
    if (!url.includes('linkedin.com/search/results/content')) {
      fail('queryUrl is LinkedIn content search', 'contains linkedin.com/search/results/content', url);
    }
    if (!url.includes('keywords=')) {
      fail('queryUrl has keywords param', 'contains keywords=', url);
    }
    if (!url.includes('sortBy=%5B%22date_posted%22%5D')) {
      fail('queryUrl has sortBy=date_posted (latest sort)', 'contains sortBy=%5B%22date_posted%22%5D', url, 'URL must be built by build-url.mjs, not hand-crafted');
    }
    if (!url.includes('datePosted=%5B%22past-')) {
      fail('queryUrl has datePosted tier filter', 'contains datePosted=%5B%22past-24h|week|month%22%5D', url, 'URL must be built by build-url.mjs');
    }

    // timeWindow 契约(产物层:worker 是否守信地用了 dispatcher 给的 dateRange)
    if (!isPlainObject(data.timeWindow)) {
      fail('timeWindow is object', 'object with dateRange/timePhrase', data.timeWindow, 'worker must assemble timeWindow from input fields');
    } else {
      const tw = data.timeWindow;
      for (const field of ['dateRange', 'timePhrase']) {
        if (!(field in tw)) fail('timeWindow has field ' + field, 'present', 'missing');
      }
      // dateRange 必须是 LinkedIn 原生三档之一(不自造其他值)
      if (!['past-24h', 'past-week', 'past-month'].includes(String(tw.dateRange))) {
        fail('timeWindow.dateRange is LinkedIn native tier', 'past-24h|past-week|past-month', tw.dateRange);
      }
      // 跨字段一致性:timeWindow.dateRange 必须与 queryUrl 的 datePosted 档位一致(同一份输入驱动两处,不一致说明 worker 分两路现编)
      const twRange = String(tw.dateRange);
      const urlTierMatch = String(data.queryUrl ?? '').match(/datePosted=%5B%22(past-24h|past-week|past-month)%22%5D/);
      if (urlTierMatch && urlTierMatch[1] !== twRange) {
        fail('timeWindow.dateRange matches queryUrl.datePosted tier', 'both equal ' + twRange, { timeWindowDateRange: twRange, urlDatePosted: urlTierMatch[1] },
          'dispatcher injects one dateRange; build-url.mjs derives datePosted from it; they must agree');
      }
    }

    // benchmark 结构(产物层)
    if (!isPlainObject(data.benchmark)) {
      fail('benchmark is object', 'object', data.benchmark);
    } else {
      // acceptance 列出五个字段(stopReason, scrollRounds, totalDiscovered, buttonClicks, inWindow),全查
      for (const field of ['stopReason', 'scrollRounds', 'totalDiscovered', 'buttonClicks', 'inWindow']) {
        if (!(field in data.benchmark)) fail('benchmark has field ' + field, 'present', 'missing');
      }
      // 数值字段应是有限数(scrollRounds/buttonClicks/totalDiscovered/inWindow 都是非负计数)
      for (const numField of ['scrollRounds', 'buttonClicks', 'totalDiscovered', 'inWindow']) {
        const n = Number(data.benchmark[numField]);
        if (Number.isFinite(n) && n < 0) fail('benchmark.' + numField + ' is non-negative count', '>= 0', n);
      }
    }

    // results 数组契约(产物层:全量落地 + 每条有效)
    if (!Array.isArray(data.results)) {
      fail('results is array', 'Array', typeof data.results);
    } else {
      // login_required 时 results 允许为空,且 benchmark.stopReason 应为 login_required
      const stopReason = String(data.benchmark?.stopReason ?? '');
      // 反向一致性:stopReason=login_required 表示被登录墙挡住,此时 results 必须为空(否则逻辑矛盾,疑似 worker 编造数据)
      if (stopReason === 'login_required' && data.results.length > 0) {
        fail('login_required implies empty results (worker blocked by login wall, no real data)',
          'results.length === 0 when stopReason=login_required', data.results.length,
          'if login wall hit, scroll-and-collect stops with no rows; non-empty results here mean fabricated data');
      }
      if (stopReason !== 'login_required' && data.benchmark && Number.isFinite(Number(data.benchmark.inWindow))) {
        // 全量落地一致性:results 条数应等于 benchmark.inWindow(过滤后全集,不丢)
        if (data.results.length !== Number(data.benchmark.inWindow)) {
          fail('results count matches benchmark.inWindow (full dump within window, no loss)',
            data.benchmark.inWindow, data.results.length,
            'dump all chunks and filter by window; do not truncate');
        }
        // 内部一致性:totalDiscovered 是滚动期间发现的全量(档位过滤前/去重前),inWindow 是档位内计数。
        // inWindow 不可能超过 totalDiscovered(否则 benchmark 自相矛盾,疑似 worker 现编数字)。
        const td = Number(data.benchmark.totalDiscovered);
        const iw = Number(data.benchmark.inWindow);
        if (Number.isFinite(td) && Number.isFinite(iw) && iw > td) {
          fail('benchmark.inWindow <= benchmark.totalDiscovered (in-window subset of all discovered)',
            'inWindow <= totalDiscovered', { inWindow: iw, totalDiscovered: td },
            'inWindow counts posts inside the date tier; totalDiscovered counts all seen while scrolling; subset cannot exceed superset');
        }
      }

      data.results.forEach((item, index) => {
        if (!isPlainObject(item)) {
          fail('results[' + index + '] is object', 'object', item);
          return;
        }
        for (const field of ['content', 'url']) {
          if (!(field in item)) fail('results[' + index + '] has field ' + field, 'present', 'missing');
        }
        // url 非空(每条必须有可定位的 LinkedIn 帖子链接;空 url 的行无意义,等同丢失)
        if (!String(item.url ?? '').trim()) {
          fail('results[' + index + '].url is non-empty', 'non-empty LinkedIn post URL', JSON.stringify(item.url));
        }
        // authorName 或 authorHandle 至少一个
        if (!String(item.authorName ?? '').trim() && !String(item.authorHandle ?? '').trim()) {
          fail('results[' + index + '] has authorName or authorHandle', 'present', { authorName: item.authorName, authorHandle: item.authorHandle });
        }
        // postedAtLabel 或 postedAt 至少一个
        if (!String(item.postedAtLabel ?? '').trim() && !String(item.postedAt ?? '').trim()) {
          fail('results[' + index + '] has postedAtLabel or postedAt', 'present', { postedAtLabel: item.postedAtLabel, postedAt: item.postedAt });
        }
        // content 非空(LinkedIn 卡片文本至少 20 字符才有意义)
        if (String(item.content ?? '').trim().length < 20) {
          fail('results[' + index + '].content is meaningful', '>= 20 chars', String(item.content ?? '').length);
        }
        // authorHandle 若存在,必须是 /in/ 或 /company/(LinkedIn 身份链接)
        const handle = String(item.authorHandle ?? '').trim();
        if (handle && !handle.includes('/in/') && !handle.includes('/company/')) {
          fail('results[' + index + '].authorHandle is LinkedIn profile/company link', 'contains /in/ or /company/', handle);
        }
      });

      // 去重:每条 url 应唯一。dom-collector 自带去重,但 worker 若重复跑 collect 或重复 append 同一 chunk,
      // 会出现重复行 —— 计数对得上(results.length==inWindow)但内容重复,是隐性数据腐败。
      const seen = new Set();
      const dupes = [];
      data.results.forEach((item, i) => {
        const u = String(item.url ?? '').trim();
        if (!u) return;
        if (seen.has(u)) dupes.push({ index: i, url: u });
        else seen.add(u);
      });
      if (dupes.length) {
        fail('results have unique urls (no duplicate posts)', 'all urls unique', dupes.slice(0, 5),
          'dom-collector dedups in-memory; duplicates here mean the worker re-ran scroll-and-collect or appended the same dump-result chunk twice');
      }
    }
  }
}

if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exit(1); }
console.log('PASS');
