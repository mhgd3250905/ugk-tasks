// filter-lib.mjs — Instagram 搜索结果的归一化 / 过滤 / 打分纯函数。
// 全部纯函数(无 IO、无网络、无 DOM),可单测。ins-search taskbook 的决策逻辑全在这里,
// main 编排(navigate/scroll/dump)在页面脚本 + worker skill.md 里。
//
// 从源 skill ins_search_latest_lib.mjs 迁移 + 改造:
//   - 保留:caption 解析、OG description 解析、关键词匹配、日期窗口过滤、去重、排序
//   - 改造:无 host-bridge 依赖,纯数据进出;暴露更细粒度的纯函数便于单测

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * NFKC 归一化 + 小写 + 压空白。用于关键词匹配(大小写/全半角不敏感)。
 */
export function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 压空白后按 limit 截断(末尾留 ...)。content/caption 落地用。
 */
export function trimText(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

/**
 * 解析点赞/评论数("1,234" / "1234" / 数字 → number;非法 → null)。
 * Instagram OG description 常是 "1,234 likes, 56 comments" 格式。
 */
export function parseCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 解析 Instagram OG description(meta[property="og:description"])。
 *
 * 真实格式(2026 实测,IG 已移除 ld+json,OG 是唯一结构化源):
 *   - 中文 UI:'"6 likes, 1 comments -  medtrumofficial，December 12, 2025 : \"caption text\". "'
 *   - 英文 UI:'"123 likes, 45 comments - author_name, "caption text""'
 *   - 个人主页:'"844 位粉丝、已关注 163 人、 83 篇帖子 - 查看 Medtrum Tech (@medtrumofficial) ..."'
 *
 * 规律:
 *   - likes: `(\d+) likes?`(英文 UI),中文 UI 的帖子页也是英文 "likes"
 *   - comments: `(\d+) comments?`
 *   - author: 在 `- ` 之后,用 `，`(中文逗号)或 `,`(英文逗号)结束
 *   - caption: 在 ` : ` 之后的引号里 `"..."`(帖子页),或不存在(主页/无 caption)
 *   - postedAt: author 之后、caption 之前的日期片段(`December 12, 2025` / `June 30`)
 *
 * 返回 { author, caption, postedAt, likeCount, commentCount },解析不出留空/null。
 */
export function parseOgDescription(metaDescription) {
  const raw = String(metaDescription || '').trim();
  if (!raw) {
    return { author: '', caption: '', postedAt: '', likeCount: null, commentCount: null };
  }

  const likeMatch = raw.match(/(\d[\d,]*)\s+likes?/i);
  const commentMatch = raw.match(/(\d[\d,]*)\s+comments?/i);

  // author:在 `- ` 之后,到下一个 `，`/`,`/`:` 之前。
  // 实测:`-  medtrumofficial，`(中文逗号)或 `- author,`(英文逗号)
  // 注意 `- ` 后可能有多个空格。
  const authorMatch = raw.match(/-\s+([^\s,，：:][^,，：]*?)\s*[,，：:]/);

  // caption:在引号里(帖子页 OG)。两种实测格式:
  //   - 新中文:`December 12, 2025 : "💪 caption text". `(冒号后引号)
  //   - 旧英文:`jane_doe, "love this pump"`(逗号后引号)
  // 统一抓最后一个 `"..."` 块(帖子 caption 在 OG 末尾的引号里)。
  const captionMatch = raw.match(/[""]([\s\S]*?)[""]\s*\.?\s*$/);

  // postedAt:author 之后、caption 之前的日期。authorMatch 拿到后,从原 raw 里截 author 后到 ` : "` 的部分。
  let postedAt = '';
  if (authorMatch) {
    const afterAuthor = raw.slice(authorMatch.index + authorMatch[0].length);
    // afterAuthor 形如 `December 12, 2025 : "caption"` 或 `"caption"`(无日期)
    const dateInTail = afterAuthor.match(/^\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})\s*:/);
    if (dateInTail) {
      postedAt = dateInTail[1].trim();
    } else {
      // 中文日期或其它格式:截到 ` : "` 前
      const dateSeg = afterAuthor.match(/^\s*([^:]+?)\s*:/);
      if (dateSeg && !dateSeg[1].includes('"')) postedAt = dateSeg[1].trim();
    }
  }

  return {
    author: authorMatch ? authorMatch[1].trim() : '',
    caption: captionMatch ? captionMatch[1].trim() : '',
    postedAt,
    likeCount: likeMatch ? Number.parseInt(likeMatch[1].replace(/[^\d]/g, ''), 10) : null,
    commentCount: commentMatch ? Number.parseInt(commentMatch[1].replace(/[^\d]/g, ''), 10) : null,
  };
}

/**
 * 从 caption 派生标题:第一段的第一句,截到 maxLength。
 * 无 caption 返回空。
 */
export function deriveTitle(caption, maxLength = 80) {
  const raw = String(caption || '').trim();
  if (!raw) return '';
  const firstSegment =
    raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean) || raw;
  const firstSentence =
    firstSegment
      .split(/[.!?。！？]/)[0]
      .replace(/\s+/g, ' ')
      .trim() || firstSegment.replace(/\s+/g, ' ').trim();
  if (firstSentence.length <= maxLength) return firstSentence;
  return `${firstSentence.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

/**
 * 关键词匹配(NFKC 归一化后 substring)。空关键词 → true(放行所有)。
 */
export function includesKeyword(value, keyword) {
  return normalizeText(value).includes(normalizeText(keyword));
}

/**
 * 构造匹配理由(用于 explainability:为什么这条被保留)。
 * 优先级:author > caption > title > url > seed(seed = 仅靠种子页发现,正文未直接命中)。
 */
export function buildMatchReason(post, keyword) {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) return 'unknown';
  if (includesKeyword(post.author, keyword)) return 'author';
  if (includesKeyword(post.caption, keyword)) return 'caption';
  if (includesKeyword(post.titleDerived, keyword)) return 'title';
  if (includesKeyword(post.postUrl, keyword)) return 'url';
  return 'seed';
}

/**
 * 归一化从 ld+json / DOM 抽取的原始帖子数据。
 * 缺 postUrl 或 postedAt 或 author → 返回 null(前置条件不满足,丢弃)。
 * OG description 的字段作为 fallback。
 *
 * @param {object} raw - { url, author, postedAt, caption, likeCount, commentCount, metaDescription, visibleTextExcerpt }
 * @param {string} matchedBy - 'hashtag' | 'keyword_search' | 'account'(种子类型)
 * @returns {object|null} 归一化后的 post 或 null
 */
export function normalizeInstagramPost(raw, matchedBy) {
  const postUrl = String(raw?.url || '').trim();
  const parsedMeta = parseOgDescription(raw?.metaDescription);
  // postedAt:优先 ld+json 的 uploadDate(2026 实测已失效),fallback 到 OG 解析出的日期
  const postedAt =
    String(raw?.postedAt || '').trim() || parsedMeta.postedAt;
  if (!postUrl || !postedAt) return null;

  const author =
    String(raw?.author || '').replace(/\s+/g, ' ').trim() || parsedMeta.author;
  if (!author) return null;

  const rawCaption = String(raw?.caption || '').replace(/\s+/g, ' ').trim();
  const rawMetaDescription = String(raw?.metaDescription || '')
    .replace(/\s+/g, ' ')
    .trim();
  // caption 优先用 ld+json 的 articleBody;若是 OG description 的拷贝则降级到 parsedMeta.caption
  const caption =
    (rawCaption &&
    rawCaption !== rawMetaDescription &&
    !/^\d+\s+likes?,\s+\d+\s+comments?\s*-/i.test(rawCaption)
      ? rawCaption
      : '') ||
    parsedMeta.caption ||
    String(raw?.visibleTextExcerpt || '').replace(/\s+/g, ' ').trim();

  return {
    postUrl,
    postedAt,
    author,
    titleDerived: deriveTitle(caption),
    caption,
    likeCount: parseCount(raw?.likeCount) ?? parsedMeta.likeCount,
    commentCount: parseCount(raw?.commentCount) ?? parsedMeta.commentCount,
    matchedBy,
  };
}

/**
 * 按关键词 + 时间窗口过滤并排序帖子。
 *
 * @param {Array} posts - normalizeInstagramPost 的输出数组
 * @param {object} options - { keyword, days, nowMs? }
 * @returns {Array} 过滤后的帖子(按 postedAt 倒序),每条加 matchReason
 */
export function selectRecentRelevantPosts(posts, options) {
  const keyword = String(options?.keyword || '').trim();
  const days = Math.max(1, Number(options?.days || 30));
  const nowMs = Number(options?.nowMs || Date.now());
  const cutoffMs = nowMs - days * DAY_MS;

  return (Array.isArray(posts) ? posts : [])
    .map((post) => {
      const postedAtMs = Date.parse(post?.postedAt || '');
      // postedAt 解析失败 → 丢弃(无法判定时间,保留会污染结果)
      if (!Number.isFinite(postedAtMs) || postedAtMs < cutoffMs) {
        return null;
      }
      const haystack = [post?.author, post?.caption, post?.titleDerived, post?.postUrl].join(' ');
      if (!includesKeyword(haystack, keyword)) {
        return null;
      }
      return { ...post, matchReason: buildMatchReason(post, keyword) };
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.postedAt) - Date.parse(left.postedAt));
}

/**
 * URL 路径分段编码(用于 hashtag / 用户名拼 URL)。
 */
export function encodeInstagramPathSegment(value) {
  return encodeURIComponent(String(value || '').trim());
}

/**
 * 从 topsearch payload 构造种子 URL 列表(关键词页 + 精确 hashtag/用户 + 模糊匹配)。
 * 优先级:关键词搜索页 > 精确 hashtag > 精确用户 > 模糊用户 > 模糊 hashtag。
 *
 * @param {string} keyword
 * @param {object} payload - IG /web/search/topsearch/ 的 JSON({hashtags:[], users:[]})
 * @returns {Array<string>} 去重后的种子 URL 列表
 */
export function buildInstagramSeedUrls(keyword, payload) {
  const urls = [buildInstagramSearchUrlForSeed(keyword)];
  const seen = new Set(urls);
  const exactHashtagUrls = [];
  const exactUserUrls = [];
  const fuzzyUserUrls = [];
  const fuzzyHashtagUrls = [];

  for (const entry of payload?.hashtags || []) {
    const hashtagName = String(entry?.hashtag?.name || '').trim();
    if (!hashtagName || !includesKeyword(hashtagName, keyword)) continue;
    const url = `https://www.instagram.com/explore/tags/${encodeInstagramPathSegment(hashtagName)}/`;
    if (seen.has(url)) continue;
    seen.add(url);
    if (normalizeText(hashtagName) === normalizeText(keyword)) {
      exactHashtagUrls.push(url);
    } else {
      fuzzyHashtagUrls.push(url);
    }
  }

  for (const entry of payload?.users || []) {
    const username = String(entry?.user?.username || '').trim();
    const fullName = String(entry?.user?.full_name || '').trim();
    if (!username || (!includesKeyword(username, keyword) && !includesKeyword(fullName, keyword))) {
      continue;
    }
    const url = `https://www.instagram.com/${encodeInstagramPathSegment(username)}/`;
    if (seen.has(url)) continue;
    seen.add(url);
    if (
      normalizeText(username) === normalizeText(keyword) ||
      normalizeText(fullName) === normalizeText(keyword)
    ) {
      exactUserUrls.push(url);
    } else {
      fuzzyUserUrls.push(url);
    }
  }

  return [
    ...urls,
    ...exactHashtagUrls,
    ...exactUserUrls,
    ...fuzzyUserUrls,
    ...fuzzyHashtagUrls,
  ];
}

// 构造 Instagram 关键词搜索 URL(export,给 build-url.mjs CLI + 单测用)。
// 注意:这里不校验空 keyword —— 调用方(build-url.mjs CLI / buildInstagramSeedUrls)负责。
// build-url.mjs 的 CLI 入口有显式 throw 包装,公开的 buildInstagramSearchUrl 带 throw 校验。
function buildInstagramSearchUrlForSeed(keyword) {
  return `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(String(keyword || '').trim())}`;
}

/**
 * 公开 API:构造 IG 关键词搜索 URL。空 keyword throw(fail-loud)。
 * build-url.mjs CLI 包装这个函数,单测直接测它。
 */
export function buildInstagramSearchUrl(keyword) {
  const trimmed = String(keyword || '').trim();
  if (!trimmed) {
    throw new Error('keyword is required (build-instagram-search-url)');
  }
  return buildInstagramSearchUrlForSeed(trimmed);
}

/**
 * 从种子页 a[href] 链接文本里解析日期(用于 seed 阶段优先级排序)。
 * 支持:'January 5, 2026' / '5 days ago' / '5天前'。
 * 解析不出返回 null。
 */
export function parseInstagramSeedLabelDate(label, nowMs = Date.now()) {
  const normalized = String(label || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const englishAbsolute = normalized.match(/\b(?:on\s+)?([A-Z][a-z]+ \d{1,2}, \d{4})\b/);
  if (englishAbsolute) {
    const parsed = Date.parse(englishAbsolute[1]);
    if (Number.isFinite(parsed)) return parsed;
  }

  const relativeDays = normalized.match(/(\d+)\s*(?:days?|天)前?/i);
  if (relativeDays) {
    const days = Number.parseInt(relativeDays[1], 10);
    if (Number.isFinite(days)) {
      return nowMs - days * DAY_MS;
    }
  }

  return null;
}

/**
 * 把候选种子按发现时间排序(近期优先)。discoveredAtMs 为 null 的排末尾。
 */
export function prioritizeCandidates(candidates) {
  return [...candidates].sort((left, right) => {
    const leftMs =
      typeof left.discoveredAtMs === 'number' && Number.isFinite(left.discoveredAtMs)
        ? left.discoveredAtMs
        : Number.NEGATIVE_INFINITY;
    const rightMs =
      typeof right.discoveredAtMs === 'number' && Number.isFinite(right.discoveredAtMs)
        ? right.discoveredAtMs
        : Number.NEGATIVE_INFINITY;
    return rightMs - leftMs;
  });
}
