// filter-lib.mjs — Reddit 搜索结果的归一化 / 时间档位映射 / votes 解析纯函数。
// 全部纯函数(无 IO、无网络、无 DOM),可单测。

/**
 * Reddit 原生时间档位(search URL 的 t 参数)。
 * 2026 实测:登录态 SSR 搜索页 t 参数生效(t=week 只返回本周帖)。
 */
export const VALID_TIME_RANGES = ['hour', 'day', 'week', 'month', 'year', 'all'];

/**
 * 把用户自然语言时间意图映射到 Reddit 原生档位。
 * Reddit 只支持 6 档(粗粒度),没有 past-3-days 这种。映射规则:归到覆盖它的最近档位(不漏)。
 *
 * @param {string} days - dispatcher 算出的天数(正整数字符串或数字)
 * @returns {string} 'hour'|'day'|'week'|'month'|'year'|'all'
 */
export function mapDaysToTimeRange(days) {
  const d = Math.max(1, Math.floor(Number(days) || 30));
  if (d <= 0) return 'all'; // 防御:非法值兜底 all
  if (d < 1) return 'hour'; // <1 天(几小时)→ hour
  if (d === 1) return 'day';
  if (d <= 7) return 'week';
  if (d <= 31) return 'month';
  if (d <= 365) return 'year';
  return 'all';
}

/**
 * 构造 Reddit 搜索 URL。
 * @param {string} keyword - 原始关键词(原样编码,不扩词)
 * @param {string} timeRange - Reddit 原生档位(默认 week)
 * @returns {string} 完整 URL
 * @throws {Error} keyword 空 or timeRange 非法
 */
export function buildRedditSearchUrl(keyword, timeRange = 'week') {
  const trimmed = String(keyword || '').trim();
  if (!trimmed) throw new Error('keyword is required (build-reddit-search-url)');
  if (!VALID_TIME_RANGES.includes(timeRange)) {
    throw new Error(`invalid timeRange "${timeRange}", must be one of: ${VALID_TIME_RANGES.join('|')}`);
  }
  return `https://www.reddit.com/search/?q=${encodeURIComponent(trimmed)}&sort=new&t=${timeRange}`;
}

/**
 * NFKC 归一化 + 小写 + 压空白。
 */
export function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 从帖子卡片的 fullText 解析 votes 和 comments 数。
 * 实测 Reddit SSR 文本格式:'2 votes·5 comments' / '1 vote·0 comments' / '5.2k votes·100 comments'
 * (中点 · 分隔,数字可能带 k/m 后缀)
 *
 * @param {string} text - 卡片文本
 * @returns {{score: number, numComments: number}}
 */
export function parseVotesAndComments(text) {
  const t = String(text || '');
  // 分数:数字 + 可选 k/m +空格+ vote(s)
  const scoreMatch = t.match(/([\d.]+)\s*([kmK M]?)(?:\s+votes?\b)/);
  // 评论:数字 + 可选 k/m +空格+ comment(s)
  const commentMatch = t.match(/([\d.]+)\s*([kmK M]?)(?:\s+comments?\b)/);
  const toNum = (n, suffix) => {
    const num = parseFloat(n);
    if (!Number.isFinite(num)) return 0;
    const s = String(suffix || '').toLowerCase().trim();
    if (s === 'k') return Math.round(num * 1000);
    if (s === 'm') return Math.round(num * 1000000);
    return Math.round(num);
  };
  return {
    score: scoreMatch ? toNum(scoreMatch[1], scoreMatch[2]) : 0,
    numComments: commentMatch ? toNum(commentMatch[1], commentMatch[2]) : 0,
  };
}

/**
 * 关键词匹配(NFKC 归一化后 substring,大小写不敏感)。
 */
export function matchKeyword(text, keyword) {
  const normalizedText = normalizeText(text);
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) return true;
  if (normalizedText.includes(normalizedKeyword)) return true;
  // 多词:每个词分别出现
  const words = normalizedKeyword.split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.every((w) => normalizedText.includes(w));
  return false;
}

/**
 * 从 permalink 解析 subreddit + postId。
 * permalink 格式:/r/{subreddit}/comments/{postId}/{title_slug}/
 * @returns {{subreddit: string, postId: string, permalink: string}}
 */
export function parsePermalink(permalink) {
  const p = String(permalink || '').trim();
  const m = p.match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
  return {
    subreddit: m ? m[1] : '',
    postId: m ? m[2] : '',
    permalink: p.startsWith('http') ? p : (p.startsWith('/') ? `https://www.reddit.com${p}` : `https://www.reddit.com/${p}`),
  };
}

/**
 * 归一化从 DOM 抽取的原始帖子数据。
 * 必须有 permalink + title,否则丢弃返回 null。
 *
 * @param {object} raw - { permalink, title, subreddit, postedAt(ISO), author, scoreText, bodyText }
 * @returns {object|null} 归一化后的 post
 */
export function normalizeRedditPost(raw) {
  const permalink = String(raw?.permalink || '').trim();
  const title = String(raw?.title || '').trim();
  if (!permalink || !title) return null;

  const parsed = parsePermalink(permalink);
  const subreddit = String(raw?.subreddit || '').trim().replace(/^r\//, '') || parsed.subreddit;
  const postedAt = String(raw?.postedAt || '').trim();
  // postedAt 必须是有效 ISO(Reddit SSR time 标签给 ISO)
  if (postedAt && !Number.isFinite(Date.parse(postedAt))) return null;

  const { score, numComments } = parseVotesAndComments(raw?.scoreText || '');
  const bodyText = String(raw?.bodyText || '').trim();
  const author = String(raw?.author || '').trim();

  return {
    permalink: parsed.permalink,
    postId: parsed.postId,
    subreddit,
    title,
    postedAt,
    author,
    score,
    numComments,
    selftext: bodyText,
  };
}

/**
 * 过滤 + 去重 + 排序。
 * Reddit t 参数已服务端过滤时间,但本地再校验一次 postedAt(防 SSR 时间漂移)。
 *
 * @param {Array} posts - normalizeRedditPost 输出
 * @param {object} options - { keyword, days, nowMs? }
 * @returns {Array} 过滤后结果(按 postedAt 倒序)
 */
export function selectPosts(posts, options) {
  const keyword = String(options?.keyword || '').trim();
  const days = Math.max(1, Number(options?.days || 30));
  const nowMs = Number(options?.nowMs || Date.now());
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;

  const seen = new Set();
  return (Array.isArray(posts) ? posts : [])
    .filter((post) => {
      // 关键词匹配(title + subreddit + bodyText)
      const haystack = [post?.title, post?.subreddit, post?.selftext].join(' ');
      return matchKeyword(haystack, keyword);
    })
    .filter((post) => {
      // 时间校验:postedAt 在窗口内(无 postedAt 的丢弃,无法判定)
      if (!post?.postedAt) return false;
      const ms = Date.parse(post.postedAt);
      if (!Number.isFinite(ms)) return false;
      return ms >= cutoffMs - 1000 && ms <= nowMs + 5 * 60 * 1000;
    })
    .filter((post) => {
      const key = post.postId || post.permalink;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
}
