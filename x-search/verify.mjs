import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// verify 只管"产物层语义校验":worker 是否按 contract 产出了有效结果。
// 输入层校验(required 字段存在/有效)由 dispatcher 门禁负责(task-dispatcher.ts),
// 这里不重复 —— dispatcher 失败时 worker 根本拿不到 runtimeInput,task 早就 throw 了。
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
const outputFile = join(outDir, 'x_search_results.json');
const taskInput = parseJsonText(process.env.TASK_INPUT || '{}', 'TASK_INPUT') || {};
const keyword = String(taskInput.keyword ?? '');

// dispatcher 注入的扁平时间字段(contract.runtimeInput)。worker 必须原样组装进 timeWindow,
// 不能现编/重算(否则等于绕过 dispatcher 的时间语义)。只有 dispatcher 真正给了值才比;
// TASK_INPUT 缺字段时由 dispatcher 门禁负责,这里不重复报。
function inputDefined(value) { return value !== undefined && value !== null && String(value).trim() !== ''; }
const hasTimePhrase = inputDefined(taskInput.timePhrase);
const hasTimeMode = inputDefined(taskInput.timeMode);
const hasTimeAmount = inputDefined(taskInput.timeAmount);
const hasTimeUnit = inputDefined(taskInput.timeUnit);
const hasStartIso = inputDefined(taskInput.startIso);
const hasEndIso = inputDefined(taskInput.endIso);
const hasCanonical = inputDefined(taskInput.canonical);

if (!existsSync(outputFile)) {
  fail('output artifact exists', 'x_search_results.json', 'missing', 'worker must write the main JSON artifact');
} else {
  const data = parseJsonText(readFileSync(outputFile, 'utf8'), 'x_search_results.json');
  if (data) {
    // 顶层字段
    for (const field of ['normalizedKeyword', 'rawQuery', 'timeWindow', 'cutoffIso', 'searchUrl', 'method', 'benchmark', 'results']) {
      if (!(field in data)) fail('output has field ' + field, 'present', 'missing');
    }

    // keyword 契约(产物层:worker 是否用了正确的 keyword)
    if (String(data.rawQuery ?? '') !== keyword) fail('rawQuery matches TASK_INPUT.keyword', keyword, data.rawQuery);
    if (!String(data.normalizedKeyword ?? '').trim()) fail('normalizedKeyword is non-empty', 'non-empty string', data.normalizedKeyword);

    // timeWindow 契约(产物层:worker 是否守信地用了 dispatcher 算的值 + 组装正确)。
    // 注意:startIso 能否 parse 成日期是"产物语义"——dispatcher 可能输出残片字符串(机制层无法通用判),
    // worker 若原样用,这里抓到"startIso 不是有效日期",这正是 verify 该干的。
    let startMs = NaN;
    let endMs = NaN;
    if (!isPlainObject(data.timeWindow)) {
      fail('timeWindow is object', 'object with raw/mode/startIso/endIso/canonical', data.timeWindow, 'worker must assemble timeWindow from flat input fields');
    } else {
      const tw = data.timeWindow;
      for (const field of ['raw', 'mode', 'amount', 'unit', 'startIso', 'endIso', 'canonical']) {
        if (!(field in tw)) fail('timeWindow has field ' + field, 'present', 'missing');
      }
      if (!['rolling', 'calendar', 'calendar_to_now'].includes(String(tw.mode))) {
        fail('timeWindow.mode is valid', 'rolling|calendar|calendar_to_now', tw.mode);
      }
      if (!['hour', 'day', 'week', 'month'].includes(String(tw.unit))) {
        fail('timeWindow.unit is valid', 'hour|day|week|month', tw.unit);
      }
      if (!Number.isFinite(Number(tw.amount)) || Number(tw.amount) <= 0) {
        fail('timeWindow.amount is positive number', 'positive number', tw.amount);
      }
      // 产物语义:startIso/endIso 必须是有效日期(抓 dispatcher 残片 + worker 现编)
      startMs = parseTime(tw.startIso, 'timeWindow.startIso');
      endMs = parseTime(tw.endIso, 'timeWindow.endIso');
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && !(startMs < endMs)) {
        fail('timeWindow.startIso < timeWindow.endIso', 'start before end', { startIso: tw.startIso, endIso: tw.endIso });
      }
      const cutoffMs = parseTime(data.cutoffIso, 'cutoffIso');
      if (Number.isFinite(cutoffMs) && Number.isFinite(startMs) && cutoffMs !== startMs) {
        fail('cutoffIso equals timeWindow.startIso', tw.startIso, data.cutoffIso);
      }
      // 产物契约:timeWindow 必须忠实反映 dispatcher 注入的扁平字段(spec hardConstraint #3:
      // "时间窗口由 dispatcher 算好注入扁平字段,worker 只读")。worker 若重算/现编时间语义,
      // 这里抓到 tw.X != TASK_INPUT.X —— 这是最严重的语义偏离(等于绕过 dispatcher)。
      // 仅在 dispatcher 真正给了对应值时比(残片/缺失交给 dispatcher 门禁)。
      if (hasTimePhrase && String(tw.raw ?? '') !== String(taskInput.timePhrase)) {
        fail('timeWindow.raw matches TASK_INPUT.timePhrase', taskInput.timePhrase, tw.raw, 'worker must echo dispatcher timePhrase, not re-derive it');
      }
      if (hasTimeMode && String(tw.mode ?? '') !== String(taskInput.timeMode)) {
        fail('timeWindow.mode matches TASK_INPUT.timeMode', taskInput.timeMode, tw.mode, 'worker must echo dispatcher timeMode');
      }
      if (hasTimeUnit && String(tw.unit ?? '') !== String(taskInput.timeUnit)) {
        fail('timeWindow.unit matches TASK_INPUT.timeUnit', taskInput.timeUnit, tw.unit, 'worker must echo dispatcher timeUnit');
      }
      if (hasTimeAmount && Number(tw.amount) !== Number(taskInput.timeAmount)) {
        fail('timeWindow.amount matches TASK_INPUT.timeAmount', taskInput.timeAmount, tw.amount, 'worker must echo dispatcher timeAmount');
      }
      if (hasCanonical && String(tw.canonical ?? '') !== String(taskInput.canonical)) {
        fail('timeWindow.canonical matches TASK_INPUT.canonical', taskInput.canonical, tw.canonical, 'worker must echo dispatcher canonical label');
      }
      if (hasStartIso && String(tw.startIso ?? '') !== String(taskInput.startIso)) {
        fail('timeWindow.startIso matches TASK_INPUT.startIso', taskInput.startIso, tw.startIso, 'worker must use dispatcher-computed window start, not re-derive');
      }
      if (hasEndIso && String(tw.endIso ?? '') !== String(taskInput.endIso)) {
        fail('timeWindow.endIso matches TASK_INPUT.endIso', taskInput.endIso, tw.endIso, 'worker must use dispatcher-computed window end, not re-derive');
      }
    }

    // searchUrl 编码正确(产物层:worker 是否构造了正确的 X URL)
    const expectedUrl = 'https://x.com/search?q=' + encodeURIComponent(String(data.normalizedKeyword ?? '')) + '&src=typed_query&f=live';
    if (String(data.searchUrl ?? '') !== expectedUrl) fail('searchUrl is encoded X Latest URL', expectedUrl, data.searchUrl);

    // normalizedKeyword 应等于 keyword(rawQuery 已查,但 normalizedKeyword 之前只查非空;
    // 这里堵"normalizedKeyword 跑偏但 searchUrl 自洽"的假通过)。
    if (keyword && String(data.normalizedKeyword ?? '') !== keyword) {
      fail('normalizedKeyword matches TASK_INPUT.keyword', keyword, data.normalizedKeyword, 'normalizedKeyword must equal the requested keyword');
    }

    // method 记录了来源(产物层)
    const method = String(data.method ?? '').toLowerCase();
    if (!method.includes('x-search') && !method.includes('x-searcher')) fail('method records x-search', 'contains x-search', data.method);
    if (!method.includes('chrome') && !method.includes('cdp')) fail('method records Chrome/CDP', 'contains chrome or cdp', data.method);

    // benchmark 结构(产物层)
    if (!isPlainObject(data.benchmark)) {
      fail('benchmark is object', 'object', data.benchmark);
    } else {
      for (const field of ['stopReason', 'score', 'grade', 'cutoffReached', 'anchorScrolls', 'rowsInspected', 'validRate', 'filteredRows']) {
        if (!(field in data.benchmark)) fail('benchmark has field ' + field, 'present', 'missing');
      }
      // score 是 anchor-scroll.js 的累加分(cutoff 20 + base 15 + overlap 15 + collector 15 + stopQuality 0-10 + validRate 10 + keywordMatch 10 + 5),
      // 范围 [0, 100],对应 grade 90/75/50 分档。不是 [0,1] 归一化。
      const score = Number(data.benchmark.score);
      if (!Number.isFinite(score)) fail('benchmark.score is finite', 'number', data.benchmark.score);
      else if (score < 0 || score > 100) fail('benchmark.score in [0,100]', '0..100', score, 'score is an additive 0-100 quality score (see anchor-scroll.js)');
      const validRate = Number(data.benchmark.validRate);
      if (Number.isFinite(validRate) && (validRate < 0 || validRate > 1)) {
        fail('benchmark.validRate in [0,1]', '0..1', validRate, 'validRate is a ratio in [0,1]');
      }
      const filteredRows = Number(data.benchmark.filteredRows);
      if (Number.isFinite(filteredRows) && filteredRows < 0) {
        fail('benchmark.filteredRows >= 0', 'non-negative', filteredRows);
      }
    }

    // results 数组契约(产物层:全量落地 + 每条有效 + 落在时间窗内)
    if (!Array.isArray(data.results)) {
      fail('results is array', 'Array', typeof data.results);
    } else {
      // 全量落地一致性:results 条数应等于 benchmark.filteredRows(不丢)
      if (data.benchmark && Number.isFinite(Number(data.benchmark.filteredRows))) {
        if (data.results.length !== Number(data.benchmark.filteredRows)) {
          fail('results count matches benchmark.filteredRows (full dump, no loss)',
            data.benchmark.filteredRows, data.results.length,
            'dump all chunks; do not truncate');
        }
      }

      const windowToleranceMs = 5 * 60 * 1000; // allow small run-time/clock drift around "now" windows
      const seenUrls = new Set();
      data.results.forEach((item, index) => {
        if (!isPlainObject(item)) {
          fail('results[' + index + '] is object', 'object', item);
          return;
        }
        for (const field of ['postedAt', 'text', 'url']) {
          if (!(field in item)) fail('results[' + index + '] has field ' + field, 'present', 'missing');
        }
        if (!String(item.author ?? '').trim() && !String(item.handle ?? '').trim()) {
          fail('results[' + index + '] has author or handle', 'author or handle present', { author: item.author, handle: item.handle });
        }
        // text 必须有可见内容(spec acceptance #6/#7:每条含 text 且保留原文;空/纯空白是坏产物)
        if (!String(item.text ?? '').trim()) {
          fail('results[' + index + '].text is non-empty', 'non-empty string', JSON.stringify(item.text), 'text must preserve tweet body');
        }
        const postedMs = parseTime(item.postedAt, 'results[' + index + '].postedAt');
        if (Number.isFinite(postedMs) && Number.isFinite(startMs) && Number.isFinite(endMs)) {
          if (postedMs < startMs - 1000 || postedMs >= endMs + windowToleranceMs) {
            fail('results[' + index + '].postedAt is within timeWindow [startIso,endIso)',
              { startIso: data.timeWindow?.startIso, endIso: data.timeWindow?.endIso }, item.postedAt,
              'anchor-scroll.js must filter by startIso and endIso');
          }
        }
        // url 必须是绝对 X/Twitter status 链接(spec:searchUrl 是 x.com;status 链接同理)。
        // 仅 /status/<digits> 太宽:相对路径/任意域名都能过。要求 https + x.com|twitter.com + /status/<digits>。
        if (!/^https:\/\/(x\.com|twitter\.com)\/[^/]+\/status\/\d+/.test(String(item.url ?? ''))) {
          fail('results[' + index + '].url is absolute X/Twitter status link',
            'https://(x.com|twitter.com)/<user>/status/<digits>', item.url);
        } else if (seenUrls.has(String(item.url))) {
          // 重复 url(同一推文落两次)= 分块 dump 拼接出错或去重缺失。
          fail('results[' + index + '].url is unique', 'no duplicate tweet url', item.url, 'dedup chunks when appending dump-result.js output');
        } else {
          seenUrls.add(String(item.url));
        }
      });
    }
  }
}

if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exit(1); }
console.log('PASS');
