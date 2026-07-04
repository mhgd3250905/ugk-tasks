// filter-lib.test.mjs — ins-search 决策逻辑的单测。
// 用 node --test 跑:node --test filter-lib.test.mjs
// 覆盖:URL 构造、归一化、OG 解析、关键词匹配、时间过滤、去重、种子优先级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInstagramSearchUrl,
  normalizeText,
  trimText,
  parseCount,
  parseOgDescription,
  deriveTitle,
  includesKeyword,
  buildMatchReason,
  normalizeInstagramPost,
  selectRecentRelevantPosts,
  buildInstagramSeedUrls,
  encodeInstagramPathSegment,
  parseInstagramSeedLabelDate,
  prioritizeCandidates,
} from './filter-lib.mjs';

// ===== buildInstagramSearchUrl =====
test('buildInstagramSearchUrl: 正常关键词', () => {
  const url = buildInstagramSearchUrl('medtrum');
  assert.equal(url, 'https://www.instagram.com/explore/search/keyword/?q=medtrum');
});

test('buildInstagramSearchUrl: 中文关键词编码', () => {
  const url = buildInstagramSearchUrl('胰岛素');
  assert.equal(url, 'https://www.instagram.com/explore/search/keyword/?q=' + encodeURIComponent('胰岛素'));
});

test('buildInstagramSearchUrl: 空格被 trim', () => {
  assert.equal(
    buildInstagramSearchUrl('  medtrum  '),
    'https://www.instagram.com/explore/search/keyword/?q=medtrum',
  );
});

test('buildInstagramSearchUrl: 空关键词 throw(fail-loud)', () => {
  assert.throws(() => buildInstagramSearchUrl(''), /keyword is required/);
  assert.throws(() => buildInstagramSearchUrl('   '), /keyword is required/);
  assert.throws(() => buildInstagramSearchUrl(null), /keyword is required/);
});

// ===== normalizeText =====
test('normalizeText: NFKC + 小写 + 压空白', () => {
  assert.equal(normalizeText('  Medtrum　TouchCare  '), 'medtrum touchcare');
  assert.equal(normalizeText('ＡＢＣ'), 'abc'); // 全角 → 半角
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
});

// ===== trimText =====
test('trimText: 短文本原样返回', () => {
  assert.equal(trimText('hello world', 100), 'hello world');
});

test('trimText: 长文本截断带 ...', () => {
  const long = 'a'.repeat(100);
  const out = trimText(long, 10);
  assert.equal(out.length, 10);
  assert.ok(out.endsWith('...'));
});

test('trimText: 空值返回空字符串', () => {
  assert.equal(trimText('', 100), '');
  assert.equal(trimText(null, 100), '');
});

// ===== parseCount =====
test('parseCount: 数字直接返回', () => {
  assert.equal(parseCount(1234), 1234);
});

test('parseCount: 字符串去非数字', () => {
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('12k'), 12);
});

test('parseCount: 非法返回 null', () => {
  assert.equal(parseCount('abc'), null);
  assert.equal(parseCount(null), null);
  assert.equal(parseCount(undefined), null);
});

// ===== parseOgDescription =====
test('parseOgDescription: 标准 "X likes, Y comments - Author"', () => {
  const r = parseOgDescription('123 likes, 45 comments - Jane Doe');
  assert.equal(r.likeCount, 123);
  assert.equal(r.commentCount, 45);
});

test('parseOgDescription: 空 → 全空', () => {
  const r = parseOgDescription('');
  assert.equal(r.author, '');
  assert.equal(r.caption, '');
  assert.equal(r.likeCount, null);
});

// 2026 实测真实格式(IG 已移除 ld+json,OG 是唯一源)
test('parseOgDescription: 真实中文 UI 帖子页 OG', () => {
  const og = '6 likes, 1 comments -  medtrumofficial，December 12, 2025 : "💪Stronger days, smoother numbers. #Medtrum #TouchCareNano". ';
  const r = parseOgDescription(og);
  assert.equal(r.likeCount, 6);
  assert.equal(r.commentCount, 1);
  assert.equal(r.author, 'medtrumofficial');
  assert.equal(r.postedAt, 'December 12, 2025');
  assert.ok(r.caption.includes('Stronger days'));
});

test('parseOgDescription: 英文 UI OG(旧格式兼容)', () => {
  const og = '123 likes, 45 comments - jane_doe, "love this pump"';
  const r = parseOgDescription(og);
  assert.equal(r.likeCount, 123);
  assert.equal(r.commentCount, 45);
  assert.equal(r.author, 'jane_doe');
  assert.equal(r.caption, 'love this pump');
});

test('parseOgDescription: 主页 OG(非帖子页,无 likes/comments 格式)', () => {
  const og = '844 位粉丝、已关注 163 人、 83 篇帖子 - 查看 Medtrum Tech (@medtrumofficial) ...';
  const r = parseOgDescription(og);
  // 主页 OG 没有 likes/comments(是粉丝数),解析不出留 null
  assert.equal(r.likeCount, null);
  // author 解析要求 `- author` 后跟分隔符(,/，/:),主页 OG author 后是 `) ...` 无分隔符,解析不出
  // 这是合理的:主页不走 extractPostDetail,这个 OG 不该被当帖子处理
  assert.equal(r.caption, '');
});

// ===== deriveTitle =====
test('deriveTitle: 第一句', () => {
  assert.equal(deriveTitle('Hello world. Rest is cut.'), 'Hello world');
});

test('deriveTitle: 多行取第一段', () => {
  assert.equal(deriveTitle('Line one\nLine two'), 'Line one');
});

test('deriveTitle: 空 caption 返回空', () => {
  assert.equal(deriveTitle(''), '');
  assert.equal(deriveTitle(null), '');
});

test('deriveTitle: 超长截断', () => {
  const long = 'a'.repeat(200);
  const t = deriveTitle(long, 50);
  assert.ok(t.length <= 50);
  assert.ok(t.endsWith('...'));
});

// ===== includesKeyword =====
test('includesKeyword: 大小写不敏感', () => {
  assert.ok(includesKeyword('Medtrum is great', 'medtrum'));
  assert.ok(includesKeyword('MEDTRUM', 'medtrum'));
});

test('includesKeyword: 空关键词放行', () => {
  assert.ok(includesKeyword('anything', ''));
});

test('includesKeyword: 不匹配返回 false', () => {
  assert.ok(!includesKeyword('hello world', 'medtrum'));
});

// ===== buildMatchReason =====
test('buildMatchReason: author 优先', () => {
  assert.equal(
    buildMatchReason({ author: 'medtrum_official', caption: 'xxx', titleDerived: '', postUrl: '' }, 'medtrum'),
    'author',
  );
});

test('buildMatchReason: caption 次之', () => {
  assert.equal(
    buildMatchReason({ author: 'jane', caption: 'love medtrum pump', titleDerived: '', postUrl: '' }, 'medtrum'),
    'caption',
  );
});

test('buildMatchReason: 无匹配返回 seed', () => {
  assert.equal(
    buildMatchReason({ author: 'jane', caption: 'hello', titleDerived: 'world', postUrl: '/p/abc' }, 'medtrum'),
    'seed',
  );
});

test('buildMatchReason: 空关键词返回 unknown', () => {
  assert.equal(buildMatchReason({ author: 'a' }, ''), 'unknown');
});

// ===== normalizeInstagramPost =====
test('normalizeInstagramPost: 缺 postUrl → null', () => {
  assert.equal(normalizeInstagramPost({ url: '', author: 'a', postedAt: '2026-01-01' }, 'hashtag'), null);
});

test('normalizeInstagramPost: 缺 postedAt → null', () => {
  assert.equal(normalizeInstagramPost({ url: 'https://ig.com/p/abc', author: 'a', postedAt: '' }, 'hashtag'), null);
});

test('normalizeInstagramPost: 缺 author → null', () => {
  assert.equal(
    normalizeInstagramPost({ url: 'https://ig.com/p/abc', author: '', postedAt: '2026-01-01' }, 'hashtag'),
    null,
  );
});

test('normalizeInstagramPost: 正常归一化', () => {
  const out = normalizeInstagramPost({
    url: 'https://www.instagram.com/p/ABC123/',
    author: 'jane_doe',
    postedAt: '2026-06-15T10:00:00',
    caption: 'My caption',
    metaDescription: '10 likes, 2 comments',
    visibleTextExcerpt: '',
  }, 'account');
  assert.equal(out.postUrl, 'https://www.instagram.com/p/ABC123/');
  assert.equal(out.author, 'jane_doe');
  assert.equal(out.caption, 'My caption');
  assert.equal(out.matchedBy, 'account');
  assert.equal(out.titleDerived, 'My caption');
});

// ===== selectRecentRelevantPosts =====
const NOW_MS = new Date('2026-07-04T00:00:00.000Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

test('selectRecentRelevantPosts: 过滤窗口外', () => {
  const posts = [
    { postUrl: 'https://ig.com/p/new', postedAt: '2026-07-01T00:00:00.000Z', author: 'medtrum', caption: 'medtrum', titleDerived: '' },
    { postUrl: 'https://ig.com/p/old', postedAt: '2026-01-01T00:00:00.000Z', author: 'medtrum', caption: 'medtrum', titleDerived: '' },
  ];
  const out = selectRecentRelevantPosts(posts, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out.length, 1);
  assert.equal(out[0].postUrl, 'https://ig.com/p/new');
});

test('selectRecentRelevantPosts: 过滤不匹配关键词', () => {
  const posts = [
    { postUrl: 'https://ig.com/p/a', postedAt: '2026-07-01T00:00:00.000Z', author: 'jane', caption: 'unrelated stuff', titleDerived: '' },
  ];
  const out = selectRecentRelevantPosts(posts, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out.length, 0);
});

test('selectRecentRelevantPosts: postedAt 解析失败 → 丢弃', () => {
  const posts = [
    { postUrl: 'https://ig.com/p/bad', postedAt: 'not-a-date', author: 'medtrum', caption: 'medtrum', titleDerived: '' },
  ];
  const out = selectRecentRelevantPosts(posts, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out.length, 0);
});

test('selectRecentRelevantPosts: 按时间倒序', () => {
  const posts = [
    { postUrl: 'https://ig.com/p/1', postedAt: '2026-06-28T00:00:00.000Z', author: 'm', caption: 'medtrum', titleDerived: '' },
    { postUrl: 'https://ig.com/p/2', postedAt: '2026-07-01T00:00:00.000Z', author: 'm', caption: 'medtrum', titleDerived: '' },
  ];
  const out = selectRecentRelevantPosts(posts, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out[0].postUrl, 'https://ig.com/p/2');
  assert.equal(out[1].postUrl, 'https://ig.com/p/1');
});

test('selectRecentRelevantPosts: 加 matchReason', () => {
  const posts = [
    { postUrl: 'https://ig.com/p/x', postedAt: '2026-07-01T00:00:00.000Z', author: 'medtrum', caption: '', titleDerived: '' },
  ];
  const out = selectRecentRelevantPosts(posts, { keyword: 'medtrum', days: 30, nowMs: NOW_MS });
  assert.equal(out[0].matchReason, 'author');
});

// ===== buildInstagramSeedUrls =====
test('buildInstagramSeedUrls: 关键词页 + 精确 hashtag + 用户', () => {
  const payload = {
    hashtags: [{ hashtag: { name: 'medtrum' } }, { hashtag: { name: 'unrelated' } }],
    users: [{ user: { username: 'medtrum_official', full_name: 'Medtrum' } }],
  };
  const seeds = buildInstagramSeedUrls('medtrum', payload);
  // 第一个是关键词搜索页
  assert.ok(seeds[0].includes('/explore/search/keyword/'));
  // 精确 hashtag
  assert.ok(seeds.some((s) => s === 'https://www.instagram.com/explore/tags/medtrum/'));
  // 用户主页
  assert.ok(seeds.some((s) => s === 'https://www.instagram.com/medtrum_official/'));
  // unrelated hashtag 不匹配,被排除
  assert.ok(!seeds.some((s) => s.includes('/explore/tags/unrelated')));
});

test('buildInstagramSeedUrls: 去重(完全相同的 hashtag 名)', () => {
  const payload = {
    hashtags: [{ hashtag: { name: 'medtrum' } }, { hashtag: { name: 'medtrum' } }],
    users: [],
  };
  const seeds = buildInstagramSeedUrls('medtrum', payload);
  const hashtagSeeds = seeds.filter((s) => s.includes('/explore/tags/'));
  assert.equal(hashtagSeeds.length, 1); // 完全同名的 hashtag 去重(URL 字符串一致)
  // 注意:medtrum 和 Medtrum 在 IG 是不同 hashtag(大小写敏感),不会被去重 —— 这是对的
});

test('buildInstagramSeedUrls: 空 payload 只有关键词页', () => {
  const seeds = buildInstagramSeedUrls('test', { hashtags: [], users: [] });
  assert.equal(seeds.length, 1);
  assert.ok(seeds[0].includes('/explore/search/keyword/'));
});

// ===== parseInstagramSeedLabelDate =====
test('parseInstagramSeedLabelDate: 英文绝对日期', () => {
  const ms = parseInstagramSeedLabelDate('January 5, 2026');
  assert.ok(Number.isFinite(ms));
});

test('parseInstagramSeedLabelDate: 相对天数', () => {
  const nowMs = new Date('2026-07-04').getTime();
  const ms = parseInstagramSeedLabelDate('5 days ago', nowMs);
  assert.equal(ms, nowMs - 5 * DAY);
});

test('parseInstagramSeedLabelDate: 中文相对', () => {
  const nowMs = new Date('2026-07-04').getTime();
  const ms = parseInstagramSeedLabelDate('3天前', nowMs);
  assert.equal(ms, nowMs - 3 * DAY);
});

test('parseInstagramSeedLabelDate: 解析不出返回 null', () => {
  assert.equal(parseInstagramSeedLabelDate('random text'), null);
  assert.equal(parseInstagramSeedLabelDate(''), null);
});

// ===== prioritizeCandidates =====
test('prioritizeCandidates: 近期优先,null 排后', () => {
  const candidates = [
    { postUrl: 'a', discoveredAtMs: null },
    { postUrl: 'b', discoveredAtMs: 1000 },
    { postUrl: 'c', discoveredAtMs: 2000 },
  ];
  const sorted = prioritizeCandidates(candidates);
  assert.equal(sorted[0].postUrl, 'c');
  assert.equal(sorted[1].postUrl, 'b');
  assert.equal(sorted[2].postUrl, 'a'); // null 排末尾
});
