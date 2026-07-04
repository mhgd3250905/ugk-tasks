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
function parseTime(value, label) {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) fail(label + ' is parseable date-time', 'valid date-time', value);
  return ms;
}

const outDir = process.env.TASK_OUTPUT_DIR || '.';
const outputFile = join(outDir, 'tiktok_search_results.json');
const taskInput = parseJsonText(process.env.TASK_INPUT || '{}', 'TASK_INPUT') || {};
const keyword = String(taskInput.keyword ?? '');
const days = Number(taskInput.days);

if (!existsSync(outputFile)) {
  fail('output artifact exists', 'tiktok_search_results.json', 'missing', 'worker must write the main JSON artifact');
} else {
  const data = parseJsonText(readFileSync(outputFile, 'utf8'), 'tiktok_search_results.json');
  if (data) {
    // 顶层字段
    for (const field of ['platform', 'keyword', 'retrievedAt', 'queryUrl', 'timeWindow', 'benchmark', 'results']) {
      if (!(field in data)) fail('output has field ' + field, 'present', 'missing');
    }

    // platform
    if (String(data.platform ?? '').toLowerCase() !== 'tiktok') {
      fail('platform is TikTok', 'TikTok', data.platform);
    }

    // keyword 契约(worker 不改写关键词)
    if (keyword && String(data.keyword ?? '') !== keyword) {
      fail('keyword matches TASK_INPUT.keyword', keyword, data.keyword);
    }

    // queryUrl 是 TikTok 搜索(含 q= 参数)
    const url = String(data.queryUrl ?? '');
    if (!url.includes('tiktok.com/search')) {
      fail('queryUrl is TikTok search', 'contains tiktok.com/search', url);
    }
    if (!url.includes('q=')) {
      fail('queryUrl has q param', 'contains q=', url);
    }

    // timeWindow 契约
    if (!isPlainObject(data.timeWindow)) {
      fail('timeWindow is object', 'object with days/timePhrase', data.timeWindow);
    } else {
      const tw = data.timeWindow;
      for (const field of ['days', 'timePhrase']) {
        if (!(field in tw)) fail('timeWindow has field ' + field, 'present', 'missing');
      }
      const twDays = Number(tw.days);
      if (!Number.isInteger(twDays) || twDays < 1) {
        fail('timeWindow.days is positive integer', '>= 1', twDays);
      } else if (Number.isInteger(days) && twDays !== days) {
        fail('timeWindow.days matches TASK_INPUT.days', days, twDays, 'worker must use dispatcher-computed days, not re-derive');
      }
      if (taskInput.timePhrase && String(tw.timePhrase ?? '') !== String(taskInput.timePhrase)) {
        fail('timeWindow.timePhrase matches TASK_INPUT.timePhrase', taskInput.timePhrase, tw.timePhrase, 'worker must echo dispatcher timePhrase');
      }
    }

    // benchmark 结构
    if (!isPlainObject(data.benchmark)) {
      fail('benchmark is object', 'object', data.benchmark);
    } else {
      for (const field of ['stopReason', 'actualScrolls', 'totalCollected', 'filteredRows', 'retriesClicked']) {
        if (!(field in data.benchmark)) fail('benchmark has field ' + field, 'present', 'missing');
      }
      for (const numField of ['actualScrolls', 'totalCollected', 'filteredRows', 'retriesClicked']) {
        const n = Number(data.benchmark[numField]);
        if (Number.isFinite(n) && n < 0) fail('benchmark.' + numField + ' is non-negative', '>= 0', n);
      }
    }

    // results 数组契约
    if (!Array.isArray(data.results)) {
      fail('results is array', 'Array', typeof data.results);
    } else {
      // 全量落地一致性
      if (data.benchmark && Number.isFinite(Number(data.benchmark.filteredRows))) {
        if (data.results.length !== Number(data.benchmark.filteredRows)) {
          fail('results count matches benchmark.filteredRows (full dump, no loss)',
            data.benchmark.filteredRows, data.results.length,
            'filter all collected; do not truncate');
        }
      }

      const nowMs = Date.now();
      const daysValue = Number.isInteger(days) && days >= 1 ? days : Number(data.timeWindow?.days) || 30;
      const cutoffMs = nowMs - daysValue * 24 * 60 * 60 * 1000;
      const futureToleranceMs = 5 * 60 * 1000;

      const seenUrls = new Set();
      data.results.forEach((item, index) => {
        if (!isPlainObject(item)) {
          fail('results[' + index + '] is object', 'object', item);
          return;
        }
        for (const field of ['postedAt', 'author', 'desc', 'url']) {
          if (!(field in item)) fail('results[' + index + '] has field ' + field, 'present', 'missing');
        }
        // postedAt 若非空,必须是有效 ISO 且落在窗口内(createTime=0 时 postedAt 允许空)
        const postedAtStr = String(item.postedAt ?? '').trim();
        if (postedAtStr) {
          const postedMs = parseTime(item.postedAt, 'results[' + index + '].postedAt');
          if (Number.isFinite(postedMs)) {
            if (postedMs < cutoffMs - 1000) {
              fail('results[' + index + '].postedAt is within time window',
                { days: daysValue, cutoffIso: new Date(cutoffMs).toISOString() }, item.postedAt,
                'selectRecentRelevantVideos must filter by days window');
            }
            if (postedMs > nowMs + futureToleranceMs) {
              fail('results[' + index + '].postedAt is not in the future', '<= now', item.postedAt);
            }
          }
        }
        // author 非空
        if (!String(item.author ?? '').trim()) {
          fail('results[' + index + '].author is non-empty', 'non-empty', item.author);
        }
        // url 必须是 TikTok 域名的 /video/ 链接
        const u = String(item.url ?? '').trim();
        if (!/^https:\/\/(?:www\.)?tiktok\.com\/@[^/]+\/video\/\d+/.test(u)) {
          fail('results[' + index + '].url is TikTok video link',
            'https://tiktok.com/@user/video/<digits>', u);
        }
        // url 去重
        if (u) {
          if (seenUrls.has(u)) {
            fail('results[' + index + '].url is unique', 'no duplicates', u,
              'duplicate videos mean worker re-ran scroll or appended same chunk twice');
          }
          seenUrls.add(u);
        }
      });
    }
  }
}

if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exit(1); }
console.log('PASS');
