// filter-lib.test.mjs — reddit-search 决策逻辑单测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRedditSearchUrl,
  mapDaysToTimeRange,
  parseVotesAndComments,
  matchKeyword,
  parsePermalink,
  normalizeRedditPost,
  selectPosts,
  VALID_TIME_RANGES,
} from './filter-lib.mjs';

const NOW_MS = new Date('2026-07-04T00:00:00.000Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

// ===== mapDaysToTimeRange(核心:days → Reddit 档位)=====
// 注:dispatcher 给的 days 是正整数(≥1),所以 hour 档位实际不可达(days=1 → day,覆盖更宽不漏)。
// hour 档保留在 VALID_TIME_RANGES 是为完整性,但 mapDaysToTimeRange 不会输出它。
test('mapDaysToTimeRange: 1 天 → day(最小输入,不映射 hour 以免漏)', () => {
  assert.equal(mapDaysToTimeRange(1), 'day');
});
test('mapDaysToTimeRange: 3 天 → week(覆盖)', () => {
  assert.equal(mapDaysToTimeRange(3), 'week');
  assert.equal(mapDaysToTimeRange(7), 'week');
});
test('mapDaysToTimeRange: 14 天 → month(归到覆盖档位)', () => {
  assert.equal(mapDaysToTimeRange(14), 'month');
  assert.equal(mapDaysToTimeRange(30), 'month');
});
test('mapDaysToTimeRange: 90 天 → year', () => {
  assert.equal(mapDaysToTimeRange(90), 'year');
  assert.equal(mapDaysToTimeRange(365), 'year');
});
test('mapDaysToTimeRange: >365 天 → all', () => {
  assert.equal(mapDaysToTimeRange(400), 'all');
  assert.equal(mapDaysToTimeRange(1000), 'all');
});
test('mapDaysToTimeRange: 非法值兜底(NaN → 默认 30 天 → month)', () => {
  assert.equal(mapDaysToTimeRange('abc'), 'month'); // Number('abc')=NaN → ||30 → 30 天 → month
  assert.equal(mapDaysToTimeRange(null), 'month');
  assert.equal(mapDaysToTimeRange(undefined), 'month');
});

// ===== buildRedditSearchUrl =====
test('buildRedditSearchUrl: 正常', () => {
  assert.equal(buildRedditSearchUrl('medtrum', 'week'), 'https://www.reddit.com/search/?q=medtrum&sort=new&t=week');
});
test('buildRedditSearchUrl: 中文编码', () => {
  assert.equal(buildRedditSearchUrl('胰岛素', 'month'), 'https://www.reddit.com/search/?q=' + encodeURIComponent('胰岛素') + '&sort=new&t=month');
});
test('buildRedditSearchUrl: 默认 timeRange=week', () => {
  assert.equal(buildRedditSearchUrl('test'), 'https://www.reddit.com/search/?q=test&sort=new&t=week');
});
test('buildRedditSearchUrl: 空 keyword throw', () => {
  assert.throws(() => buildRedditSearchUrl(''), /keyword is required/);
  assert.throws(() => buildRedditSearchUrl(null), /keyword is required/);
});
test('buildRedditSearchUrl: 非法 timeRange throw', () => {
  assert.throws(() => buildRedditSearchUrl('test', 'past-week'), /invalid timeRange/);
  assert.throws(() => buildRedditSearchUrl('test', '3days'), /invalid timeRange/);
});

// ===== parseVotesAndComments(实测 Reddit SSR 文本格式)=====
test('parseVotesAndComments: "2 votes·5 comments"', () => {
  const r = parseVotesAndComments('Medtrum nano vs omnipod\nr/Medtrum\n·\n1d ago\n2 votes·5 comments');
  assert.equal(r.score, 2);
  assert.equal(r.numComments, 5);
});
test('parseVotesAndComments: 单数 "1 vote·0 comments"', () => {
  const r = parseVotesAndComments('1 vote·0 comments');
  assert.equal(r.score, 1);
  assert.equal(r.numComments, 0);
});
test('parseVotesAndComments: k 后缀 "5.2k votes·1.2k comments"', () => {
  const r = parseVotesAndComments('5.2k votes·1.2k comments');
  assert.equal(r.score, 5200);
  assert.equal(r.numComments, 1200);
});
test('parseVotesAndComments: m 后缀', () => {
  const r = parseVotesAndComments('1.5m votes·100 comments');
  assert.equal(r.score, 1500000);
});
test('parseVotesAndComments: 无 votes/comments 文本 → 0', () => {
  assert.deepEqual(parseVotesAndComments('just title no votes'), { score: 0, numComments: 0 });
  assert.deepEqual(parseVotesAndComments(''), { score: 0, numComments: 0 });
});

// ===== matchKeyword =====
test('matchKeyword: 单词子串', () => {
  assert.ok(matchKeyword('medtrum pump review', 'medtrum'));
});
test('matchKeyword: 大小写不敏感', () => {
  assert.ok(matchKeyword('MEDTRUM', 'medtrum'));
});
test('matchKeyword: 多词分别出现', () => {
  assert.ok(matchKeyword('love medtrum, insulin great', 'medtrum insulin'));
});
test('matchKeyword: 不匹配', () => {
  assert.ok(!matchKeyword('hello world', 'medtrum'));
});
test('matchKeyword: 空关键词放行', () => {
  assert.ok(matchKeyword('anything', ''));
});

// ===== parsePermalink =====
test('parsePermalink: 标准 /r/sub/comments/id/', () => {
  const r = parsePermalink('/r/Medtrum/comments/1uluyjm/medtrum_nano/');
  assert.equal(r.subreddit, 'Medtrum');
  assert.equal(r.postId, '1uluyjm');
  assert.equal(r.permalink, 'https://www.reddit.com/r/Medtrum/comments/1uluyjm/medtrum_nano/');
});
test('parsePermalink: 完整 URL', () => {
  const r = parsePermalink('https://www.reddit.com/r/diabetes/comments/abc123/title/');
  assert.equal(r.subreddit, 'diabetes');
  assert.equal(r.postId, 'abc123');
});
test('parsePermalink: 无效格式 → 空', () => {
  const r = parsePermalink('/some/other/path/');
  assert.equal(r.subreddit, '');
  assert.equal(r.postId, '');
});

// ===== normalizeRedditPost =====
test('normalizeRedditPost: 缺 permalink → null', () => {
  assert.equal(normalizeRedditPost({ permalink: '', title: 'x' }), null);
});
test('normalizeRedditPost: 缺 title → null', () => {
  assert.equal(normalizeRedditPost({ permalink: '/r/x/comments/abc/' }), null);
});
test('normalizeRedditPost: postedAt 无效 ISO → null', () => {
  assert.equal(normalizeRedditPost({ permalink: '/r/x/comments/abc/', title: 't', postedAt: 'not-a-date' }), null);
});
test('normalizeRedditPost: 正常(含 scoreText 解析)', () => {
  const out = normalizeRedditPost({
    permalink: '/r/Medtrum/comments/1uluyjm/title/',
    title: 'Medtrum nano vs omnipod',
    subreddit: 'r/Medtrum',
    postedAt: '2026-07-02T21:21:03.401Z',
    author: '',
    scoreText: '2 votes·5 comments',
    bodyText: '',
  });
  assert.equal(out.subreddit, 'Medtrum'); // 去掉 r/ 前缀
  assert.equal(out.score, 2);
  assert.equal(out.numComments, 5);
  assert.equal(out.permalink, 'https://www.reddit.com/r/Medtrum/comments/1uluyjm/title/');
});

// ===== selectPosts =====
test('selectPosts: 过滤不匹配关键词', () => {
  const posts = [{ permalink: '/r/x/comments/a/', title: 'unrelated', subreddit: 'x', postedAt: new Date(NOW_MS - DAY).toISOString(), postId: 'a' }];
  const out = selectPosts(posts.map(p => normalizeRedditPost({permalink:p.permalink,title:p.title,subreddit:p.subreddit,postedAt:p.postedAt})).filter(Boolean), { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out.length, 0);
});
test('selectPosts: 过滤窗口外', () => {
  const posts = [{ permalink: '/r/m/comments/a/', title: 'medtrum', subreddit: 'm', postedAt: new Date(NOW_MS - 100*DAY).toISOString() }];
  const norm = posts.map(normalizeRedditPost).filter(Boolean);
  const out = selectPosts(norm, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out.length, 0);
});
test('selectPosts: 窗口内 + 匹配 → 保留', () => {
  const posts = [{ permalink: '/r/m/comments/a/', title: 'medtrum pump', subreddit: 'm', postedAt: new Date(NOW_MS - 3*DAY).toISOString() }];
  const norm = posts.map(normalizeRedditPost).filter(Boolean);
  const out = selectPosts(norm, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out.length, 1);
});
test('selectPosts: 去重(同 permalink)', () => {
  const posts = [
    { permalink: '/r/m/comments/a/', title: 'medtrum', subreddit: 'm', postedAt: new Date(NOW_MS - DAY).toISOString() },
    { permalink: '/r/m/comments/a/', title: 'medtrum', subreddit: 'm', postedAt: new Date(NOW_MS - DAY).toISOString() },
  ];
  const norm = posts.map(normalizeRedditPost).filter(Boolean);
  const out = selectPosts(norm, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out.length, 1);
});
test('selectPosts: 按时间倒序', () => {
  const posts = [
    { permalink: '/r/m/comments/a/', title: 'medtrum', subreddit: 'm', postedAt: new Date(NOW_MS - 10*DAY).toISOString() },
    { permalink: '/r/m/comments/b/', title: 'medtrum', subreddit: 'm', postedAt: new Date(NOW_MS - DAY).toISOString() },
  ];
  const norm = posts.map(normalizeRedditPost).filter(Boolean);
  const out = selectPosts(norm, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out[0].permalink.includes('/b/'), true || out[0].permalink.includes('comments/b'));
});

// ===== VALID_TIME_RANGES =====
test('VALID_TIME_RANGES 含 6 档', () => {
  assert.equal(VALID_TIME_RANGES.length, 6);
  assert.ok(VALID_TIME_RANGES.includes('week'));
  assert.ok(VALID_TIME_RANGES.includes('all'));
});
