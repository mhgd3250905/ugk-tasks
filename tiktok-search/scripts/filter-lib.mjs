// filter-lib.mjs — TikTok 搜索结果的归一化 / 日期解析 / 过滤纯函数。
// 全部纯函数(无 IO、无网络、无 DOM),可单测。tiktok-search taskbook 的决策逻辑全在这里。
//
// 从源 skill tiktok_search_latest_lib.mjs + tiktok_search_latest.mjs 的内联逻辑迁移:
//   - 保留:TikTok 三种日期格式解析(Xd/w/h/mo/y ago / M-D / YYYY-M-D)、
//           多词关键词匹配、时间窗口过滤、去重、排序
//   - 改造:无 host-bridge 依赖,纯数据进出;暴露细粒度纯函数便于单测

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * NFKC 归一化 + 小写 + 压空白。
 */
export function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 构造 TikTok 搜索 URL。空 keyword throw。
 */
export function buildTikTokSearchUrl(keyword) {
  const trimmed = String(keyword || '').trim();
  if (!trimmed) {
    throw new Error('keyword is required (build-tiktok-search-url)');
  }
  return `https://www.tiktok.com/search?q=${encodeURIComponent(trimmed)}`;
}

/**
 * 把 TikTok 日期标签文本解析成 epoch seconds(UTC)。
 * 三种格式(源自 tiktok_search_latest.mjs 的 parseDateTag):
 *   1. 相对:'1w ago', '3d ago', '14h ago', '2mo ago', '1y ago', '5m ago'
 *   2. 全日期:'YYYY-M-D' (往年)
 *   3. 短日期:'M-D' (今年,若未来则算去年)
 * 解析失败返回 0(TikTok 卡片有时无日期,调用方自行决定是否丢弃)。
 *
 * @param {string} text - 日期标签原文
 * @param {number} [nowSec] - 测试注入的当前 epoch sec,默认 Date.now()/1000
 * @returns {number} epoch seconds(0 = 解析失败/未知)
 */
export function parseTikTokDateTag(text, nowSec) {
  const trimmed = String(text || '').replace(/\s+/g, '').toLowerCase();
  if (!trimmed) return 0;
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);

  // 相对时间:'1w ago' → '1wago'
  const relMatch = trimmed.match(/^(\d+)(y|mo|w|d|h|m)ago$/);
  if (relMatch) {
    const num = Number(relMatch[1]);
    const unit = relMatch[2];
    switch (unit) {
      case 'y': return now - num * 31536000;
      case 'mo': return now - num * 2592000;
      case 'w': return now - num * 604800;
      case 'd': return now - num * 86400;
      case 'h': return now - num * 3600;
      case 'm': return now - num * 60;
      default: return 0;
    }
  }

  // 全日期:YYYY-M-D
  let match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (!Number.isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  }
  // 短日期:M-D(假设今年;若未来算去年)
  match = trimmed.match(/^(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const nowDate = new Date(now * 1000);
    const month = Number(match[1]) - 1;
    const day = Number(match[2]);
    let year = nowDate.getFullYear();
    const d = new Date(year, month, day);
    if (d.getTime() > now * 1000) {
      year -= 1;
      d.setFullYear(year);
    }
    if (!Number.isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  }
  return 0;
}

/**
 * 把 epoch seconds 格式化成 ISO 日期(YYYY-MM-DD)。0 → 空字符串。
 */
export function formatDateFromSeconds(seconds) {
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 关键词多词匹配(源自 filterResults):全文 substring 匹配 OR 每个词分别在文本中出现。
 * 单词:子串匹配;多词(>1):整串匹配 OR 每个词任意位置出现。
 */
export function matchKeyword(text, keyword) {
  const normalizedText = normalizeText(text);
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) return true;
  if (normalizedText.includes(normalizedKeyword)) return true;
  const words = normalizedKeyword.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return words.every((w) => normalizedText.includes(w));
  }
  return false;
}

/**
 * 过滤 TikTok 视频结果:关键词匹配 + 时间窗口 + 去重。
 *
 * @param {Array} rows - { url, author, desc, hashtags, createTime(epoch sec) }
 * @param {object} options - { keyword, days, nowMs? }
 * @returns {Array} 过滤后结果(按 createTime 倒序),每条加 matchReason
 */
export function selectRecentRelevantVideos(rows, options) {
  const keyword = String(options?.keyword || '').trim();
  const days = Math.max(1, Number(options?.days || 30));
  const nowMs = Number(options?.nowMs || Date.now());
  const cutoffMs = nowMs - days * DAY_MS;

  const seen = new Set();
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      const text = [row?.desc, ...(row?.hashtags || []), row?.author].join(' ');
      return matchKeyword(text, keyword);
    })
    .filter((row) => {
      // createTime=0 = 未知日期,保留(让下游决定),非 0 则必须在窗口内
      const createdMs = Number(row?.createTime) * 1000;
      if (createdMs && createdMs < cutoffMs) return false;
      return true;
    })
    .filter((row) => {
      const key = row?.url;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => ({
      url: String(row?.url || ''),
      author: String(row?.author || '').trim(),
      desc: String(row?.desc || '').replace(/\s+/g, ' ').trim(),
      hashtags: Array.isArray(row?.hashtags) ? row.hashtags : [],
      createTime: Number(row?.createTime) || 0,
      createdAt: formatDateFromSeconds(row?.createTime),
      likeCount: Number(row?.likeCount) || 0,
      matchReason: deriveMatchReason(row, keyword),
    }))
    .sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
}

function deriveMatchReason(row, keyword) {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) return 'unknown';
  const desc = normalizeText(row?.desc);
  if (desc === normalizedKeyword || desc.includes(normalizedKeyword)) return 'desc';
  const hashtags = Array.isArray(row?.hashtags) ? row.hashtags.map(normalizeText).join(' ') : '';
  if (hashtags.includes(normalizedKeyword)) return 'hashtag';
  if (normalizeText(row?.author).includes(normalizedKeyword)) return 'author';
  return 'multi-word';
}

/**
 * 把秒数解析成毫秒 ISO 字符串(给 verify / 落盘用)。0 → ''。
 */
export function createTimeToIso(createTime) {
  const ms = Number(createTime) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toISOString();
}
