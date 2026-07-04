// filter-lib.test.mjs — tiktok-search 决策逻辑的单测。
// 用 node --test 跑:node --test filter-lib.test.mjs
// 覆盖:URL 构造、归一化、TikTok 三格式日期解析、关键词多词匹配、时间过滤、去重、排序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTikTokSearchUrl,
  normalizeText,
  parseTikTokDateTag,
  formatDateFromSeconds,
  matchKeyword,
  selectRecentRelevantVideos,
  createTimeToIso,
} from './filter-lib.mjs';

const NOW_SEC = Math.floor(new Date('2026-07-04T00:00:00.000Z').getTime() / 1000);
const NOW_MS = NOW_SEC * 1000;
const DAY_S = 86400;

// ===== buildTikTokSearchUrl =====
test('buildTikTokSearchUrl: 正常关键词', () => {
  assert.equal(buildTikTokSearchUrl('medtrum'), 'https://www.tiktok.com/search?q=medtrum');
});

test('buildTikTokSearchUrl: 中文编码', () => {
  assert.equal(
    buildTikTokSearchUrl('胰岛素'),
    'https://www.tiktok.com/search?q=' + encodeURIComponent('胰岛素'),
  );
});

test('buildTikTokSearchUrl: 空格 trim', () => {
  assert.equal(buildTikTokSearchUrl('  medtrum  '), 'https://www.tiktok.com/search?q=medtrum');
});

test('buildTikTokSearchUrl: 空关键词 throw', () => {
  assert.throws(() => buildTikTokSearchUrl(''), /keyword is required/);
  assert.throws(() => buildTikTokSearchUrl('   '), /keyword is required/);
  assert.throws(() => buildTikTokSearchUrl(null), /keyword is required/);
});

// ===== normalizeText =====
test('normalizeText: NFKC + 小写 + 压空白', () => {
  assert.equal(normalizeText('  Medtrum　TouchCare  '), 'medtrum touchcare');
  assert.equal(normalizeText(null), '');
});

// ===== parseTikTokDateTag(核心:TikTok 三格式日期)=====
test('parseTikTokDateTag: 相对时间 "1w ago"', () => {
  const sec = parseTikTokDateTag('1w ago', NOW_SEC);
  assert.equal(sec, NOW_SEC - 1 * 7 * DAY_S);
});

test('parseTikTokDateTag: 相对时间 "3d ago"', () => {
  assert.equal(parseTikTokDateTag('3d ago', NOW_SEC), NOW_SEC - 3 * DAY_S);
});

test('parseTikTokDateTag: 相对时间 "14h ago"', () => {
  assert.equal(parseTikTokDateTag('14h ago', NOW_SEC), NOW_SEC - 14 * 3600);
});

test('parseTikTokDateTag: 相对时间 "2mo ago"', () => {
  assert.equal(parseTikTokDateTag('2mo ago', NOW_SEC), NOW_SEC - 2 * 2592000);
});

test('parseTikTokDateTag: 相对时间 "1y ago"', () => {
  assert.equal(parseTikTokDateTag('1y ago', NOW_SEC), NOW_SEC - 1 * 31536000);
});

test('parseTikTokDateTag: 相对时间 "5m ago"(分钟)', () => {
  assert.equal(parseTikTokDateTag('5m ago', NOW_SEC), NOW_SEC - 5 * 60);
});

test('parseTikTokDateTag: 全日期 "2025-9-26"(往年)', () => {
  const sec = parseTikTokDateTag('2025-9-26', NOW_SEC);
  assert.ok(sec > 0);
  // 验证落在 2025-09-26
  const d = new Date(sec * 1000);
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 8); // 0-indexed
  assert.equal(d.getDate(), 26);
});

test('parseTikTokDateTag: 短日期 "6-15"(今年,不未来)', () => {
  const sec = parseTikTokDateTag('6-15', NOW_SEC); // NOW=2026-07-04,6-15 是过去
  assert.ok(sec > 0);
  const d = new Date(sec * 1000);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 5);
  assert.equal(d.getDate(), 15);
});

test('parseTikTokDateTag: 短日期未来 → 算去年(如 12-25 在 7 月看是去年圣诞)', () => {
  const sec = parseTikTokDateTag('12-25', NOW_SEC); // NOW=2026-07-04,12-25 未来 → 去年
  const d = new Date(sec * 1000);
  assert.equal(d.getFullYear(), 2025);
});

test('parseTikTokDateTag: 空文本 → 0', () => {
  assert.equal(parseTikTokDateTag(''), 0);
  assert.equal(parseTikTokDateTag(null), 0);
});

test('parseTikTokDateTag: 无法解析 → 0', () => {
  assert.equal(parseTikTokDateTag('random'), 0);
  assert.equal(parseTikTokDateTag('not a date'), 0);
});

test('parseTikTokDateTag: 容错空格("3d  ago" 也能解析)', () => {
  assert.equal(parseTikTokDateTag('3d  ago', NOW_SEC), NOW_SEC - 3 * DAY_S);
});

// ===== formatDateFromSeconds =====
test('formatDateFromSeconds: 正常秒数 → ISO 日期', () => {
  // 2026-07-01 00:00:00 UTC = 1782000000 sec... 用一个已知值
  const sec = Math.floor(new Date('2026-07-01T00:00:00.000Z').getTime() / 1000);
  assert.equal(formatDateFromSeconds(sec), '2026-07-01');
});

test('formatDateFromSeconds: 0 → 空字符串', () => {
  assert.equal(formatDateFromSeconds(0), '');
});

test('formatDateFromSeconds: 负数 → 空字符串', () => {
  assert.equal(formatDateFromSeconds(-100), '');
});

// ===== matchKeyword =====
test('matchKeyword: 单词子串匹配', () => {
  assert.ok(matchKeyword('medtrum pump review', 'medtrum'));
});

test('matchKeyword: 大小写不敏感', () => {
  assert.ok(matchKeyword('MEDTRUM', 'medtrum'));
});

test('matchKeyword: 多词 — 整串匹配', () => {
  assert.ok(matchKeyword('medtrum insulin pump', 'medtrum insulin'));
});

test('matchKeyword: 多词 — 每词分别出现', () => {
  assert.ok(matchKeyword('love medtrum, insulin is great', 'medtrum insulin'));
});

test('matchKeyword: 不匹配返回 false', () => {
  assert.ok(!matchKeyword('hello world', 'medtrum'));
});

test('matchKeyword: 空关键词放行', () => {
  assert.ok(matchKeyword('anything', ''));
});

// ===== selectRecentRelevantVideos =====
test('selectRecentRelevantVideos: 过滤窗口外', () => {
  const rows = [
    { url: 'https://www.tiktok.com/@a/video/1', author: 'a', desc: 'medtrum', hashtags: [], createTime: NOW_SEC - 3 * DAY_S, likeCount: 10 },
    { url: 'https://www.tiktok.com/@b/video/2', author: 'b', desc: 'medtrum', hashtags: [], createTime: NOW_SEC - 100 * DAY_S, likeCount: 5 },
  ];
  const out = selectRecentRelevantVideos(rows, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://www.tiktok.com/@a/video/1');
});

test('selectRecentRelevantVideos: 过滤不匹配关键词', () => {
  const rows = [
    { url: 'https://www.tiktok.com/@a/video/1', author: 'a', desc: 'unrelated content', hashtags: [], createTime: NOW_SEC - DAY_S, likeCount: 10 },
  ];
  const out = selectRecentRelevantVideos(rows, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out.length, 0);
});

test('selectRecentRelevantVideos: createTime=0(未知日期)保留', () => {
  const rows = [
    { url: 'https://www.tiktok.com/@a/video/1', author: 'a', desc: 'medtrum', hashtags: [], createTime: 0, likeCount: 10 },
  ];
  const out = selectRecentRelevantVideos(rows, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out.length, 1); // 未知日期不强制丢弃
});

test('selectRecentRelevantVideos: 去重(同 url)', () => {
  const rows = [
    { url: 'https://www.tiktok.com/@a/video/1', author: 'a', desc: 'medtrum', hashtags: [], createTime: NOW_SEC - DAY_S, likeCount: 10 },
    { url: 'https://www.tiktok.com/@a/video/1', author: 'a', desc: 'medtrum', hashtags: [], createTime: NOW_SEC - DAY_S, likeCount: 10 },
  ];
  const out = selectRecentRelevantVideos(rows, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out.length, 1);
});

test('selectRecentRelevantVideos: 按 createTime 倒序', () => {
  const rows = [
    { url: 'https://www.tiktok.com/@a/video/1', author: 'm', desc: 'medtrum', hashtags: [], createTime: NOW_SEC - 10 * DAY_S, likeCount: 1 },
    { url: 'https://www.tiktok.com/@b/video/2', author: 'm', desc: 'medtrum', hashtags: [], createTime: NOW_SEC - DAY_S, likeCount: 2 },
  ];
  const out = selectRecentRelevantVideos(rows, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out[0].url, 'https://www.tiktok.com/@b/video/2'); // 近期在前
});

test('selectRecentRelevantVideos: 加 matchReason + createdAt', () => {
  const rows = [
    { url: 'https://www.tiktok.com/@medtrum/video/1', author: 'medtrum', desc: 'our pump', hashtags: [], createTime: NOW_SEC - DAY_S, likeCount: 5 },
  ];
  const out = selectRecentRelevantVideos(rows, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out[0].matchReason, 'author');
  assert.ok(out[0].createdAt); // 非空 ISO 日期
});

// ===== createTimeToIso =====
test('createTimeToIso: 正常秒数', () => {
  const sec = Math.floor(new Date('2026-07-01T00:00:00.000Z').getTime() / 1000);
  assert.equal(createTimeToIso(sec), '2026-07-01T00:00:00.000Z');
});

test('createTimeToIso: 0 → 空字符串', () => {
  assert.equal(createTimeToIso(0), '');
});
