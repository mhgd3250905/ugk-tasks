import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// verify 只管"产物层语义校验"。
const failures = [];
function fail(assertion, expected, actual, hint) { failures.push({ assertion, expected, actual, hint }); }
function parseJsonText(text, label) {
  try { return JSON.parse(text); }
  catch (error) { fail(label + ' is valid JSON', 'parseable JSON', error.message || String(error)); return null; }
}
function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function parseTime(value, label) {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) fail(label + ' is parseable date-time', 'valid date-time', value);
  return ms;
}

const outDir = process.env.TASK_OUTPUT_DIR || '.';
const outputFile = join(outDir, 'reddit_search_results.json');
const taskInput = parseJsonText(process.env.TASK_INPUT || '{}', 'TASK_INPUT') || {};
const keyword = String(taskInput.keyword ?? '');
const days = Number(taskInput.days);
const VALID_TIME_RANGES = ['hour', 'day', 'week', 'month', 'year', 'all'];

if (!existsSync(outputFile)) {
  fail('output artifact exists', 'reddit_search_results.json', 'missing', 'worker must write the main JSON artifact');
} else {
  const data = parseJsonText(readFileSync(outputFile, 'utf8'), 'reddit_search_results.json');
  if (data) {
    // 顶层字段
    for (const field of ['platform', 'keyword', 'retrievedAt', 'queryUrl', 'timeWindow', 'benchmark', 'results']) {
      if (!(field in data)) fail('output has field ' + field, 'present', 'missing');
    }
    if (String(data.platform ?? '').toLowerCase() !== 'reddit') fail('platform is Reddit', 'Reddit', data.platform);
    if (keyword && String(data.keyword ?? '') !== keyword) fail('keyword matches TASK_INPUT.keyword', keyword, data.keyword);

    // queryUrl 是 Reddit 搜索(含 q= 和 t=)
    const url = String(data.queryUrl ?? '');
    if (!url.includes('reddit.com/search')) fail('queryUrl is Reddit search', 'contains reddit.com/search', url);
    if (!url.includes('q=')) fail('queryUrl has q param', 'contains q=', url);
    if (!url.includes('t=')) fail('queryUrl has t param', 'contains t=', url);

    // timeWindow 契约
    if (!isPlainObject(data.timeWindow)) {
      fail('timeWindow is object', 'object', data.timeWindow);
    } else {
      const tw = data.timeWindow;
      for (const field of ['days', 'timePhrase', 'timeRange']) {
        if (!(field in tw)) fail('timeWindow has field ' + field, 'present', 'missing');
      }
      const twDays = Number(tw.days);
      if (!Number.isInteger(twDays) || twDays < 1) fail('timeWindow.days is positive integer', '>= 1', twDays);
      else if (Number.isInteger(days) && twDays !== days) fail('timeWindow.days matches TASK_INPUT.days', days, twDays, 'worker must use dispatcher-computed days');
      if (!VALID_TIME_RANGES.includes(String(tw.timeRange))) fail('timeWindow.timeRange is valid', VALID_TIME_RANGES.join('|'), tw.timeRange);
      if (taskInput.timePhrase && String(tw.timePhrase ?? '') !== String(taskInput.timePhrase)) fail('timeWindow.timePhrase matches TASK_INPUT.timePhrase', taskInput.timePhrase, tw.timePhrase);
    }

    // benchmark 结构
    if (!isPlainObject(data.benchmark)) {
      fail('benchmark is object', 'object', data.benchmark);
    } else {
      for (const field of ['stopReason', 'rounds', 'totalCollected', 'filteredRows']) {
        if (!(field in data.benchmark)) fail('benchmark has field ' + field, 'present', 'missing');
      }
      for (const numField of ['rounds', 'totalCollected', 'filteredRows']) {
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
          fail('results count matches benchmark.filteredRows (full dump, no loss)', data.benchmark.filteredRows, data.results.length, 'do not truncate');
        }
      }

      const seenPermalinks = new Set();
      data.results.forEach((item, index) => {
        if (!isPlainObject(item)) { fail('results[' + index + '] is object', 'object', item); return; }
        for (const field of ['postedAt', 'title', 'permalink', 'subreddit']) {
          if (!(field in item)) fail('results[' + index + '] has field ' + field, 'present', 'missing');
        }
        // postedAt 必须是有效 ISO
        parseTime(item.postedAt, 'results[' + index + '].postedAt');
        // title 非空
        if (!String(item.title ?? '').trim()) fail('results[' + index + '].title non-empty', 'non-empty', item.title);
        // permalink 必须是 reddit.com /r/{sub}/comments/{id}/ 格式
        const p = String(item.permalink ?? '');
        if (!/^https:\/\/(?:www\.)?reddit\.com\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(p)) {
          fail('results[' + index + '].permalink is Reddit post URL', 'https://reddit.com/r/.../comments/ID/', p);
        }
        // subreddit 非空(无 r/ 前缀)
        if (!String(item.subreddit ?? '').trim()) fail('results[' + index + '].subreddit non-empty', 'non-empty', item.subreddit);
        // permalink 去重
        if (p) {
          if (seenPermalinks.has(p)) fail('results[' + index + '].permalink unique', 'no duplicates', p);
          seenPermalinks.add(p);
        }
      });
    }
  }
}

if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exit(1); }
console.log('PASS');
