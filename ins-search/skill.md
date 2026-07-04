# ins-search worker 执行手册

用 UGK 管理的 `chrome_cdp` 搜索 Instagram 关键词(多种子策略:关键词页 + hashtag + 用户主页),逐帖取详情,按 `[now - days*24h, now]` 过滤,把完整结构化结果写入 `$TASK_OUTPUT_DIR/ins_search_results.json`。

## 工具就绪性(别写错层)

CDP 的启动/连接检查由 task 框架的 `requiredTools` 声明触发,**不要**在 worker 内写 `chrome_cdp status` 检查 → `chrome_cdp launch` → 重试。worker spawn 前机制已开好隔离 tab,进来直接用 `chrome_cdp navigate/evaluate` 即可。**特别提醒:不要用 host-bridge / proxy:3456 / Docker sidecar / web-access —— 这些是旧架构,已废弃,改用 chrome_cdp 工具。**

## 输入(全部已由 dispatcher 算好,worker 直接用)

从 `contract.runtimeInput` 读(都是扁平标量字段):
- `keyword`(必填):Instagram 搜索关键词,原样用于查询 URL 和过滤。
- `timePhrase`(必填):用户原始时间短语(任意语言),原样回显。
- `days`(必填):时间窗口天数(正整数 ≤90)。dispatcher 已把"最近30天/上周/past month"算成具体天数。

**worker 不解析时间。** dispatcher 是 LLM,已经算好了。

**输入校验(开 Chrome 前必做):** 上述必填字段必须全部存在且是标量。**`days` 必须是正整数(1-90)。** 若任一缺失/非标量/days 非法,直接报错退出,不要开 Chrome,不要现编默认值。

## 查询构造(调脚本,确定性,worker 不自己拼)

```bash
KEYWORD_URL=$(node "$TASK_DIR/scripts/build-url.mjs" --keyword "<keyword>")
```

脚本输出 Instagram 关键词搜索 URL,worker 直接 navigate 用。

## 执行流程

所有脚本在 `$TASK_DIR/scripts/`(环境变量 `TASK_DIR` 已注入)。

### 1. navigate 到关键词搜索页

```
chrome_cdp action=navigate url=<KEYWORD_URL> reason="local Chrome CDP logged-in browser state for Instagram keyword search" normalAccessAttempted=true
```

### 2. 等页面加载 + 登录检查

```
chrome_cdp action=evaluate expression="(() => { const t=document.title||''; const onLogin=location.pathname.includes('/accounts/login')||/log\s*in/i.test(t); return { title:t, onLogin, href:location.href }; })()" reason="local Chrome CDP logged-in browser state for Instagram keyword search" normalAccessAttempted=true
```

`onLogin=true` → 直接上报 login_required,不继续(不编造结果)。

### 3. 装 DOM 收集器

读 `$TASK_DIR/scripts/dom-collector.js` 全文,作为 `expression` 传给 `chrome_cdp evaluate`。它装 `window.__insCollector`(含 scanSeedLinks / extractPostDetail / addDiscovered)。

### 4. 调 IG topsearch API 拿 hashtag/用户

在关键词页上下文里调 IG 内部 API:

```
chrome_cdp action=evaluate expression="(async () => { const r = await fetch('/web/search/topsearch/?query=<encodeURIComponent(keyword)>', { credentials:'include', headers:{'X-Requested-With':'XMLHttpRequest'} }); const text = await r.text(); let json=null; try{json=JSON.parse(text)}catch{}; return { ok:r.ok, status:r.status, json, redirectedToLogin:location.pathname.includes('/accounts/login') }; })()" reason="local Chrome CDP logged-in browser state for Instagram keyword search" normalAccessAttempted=true
```

`ok && json` → 拿到 `{hashtags:[], users:[]}` payload。

### 5. 生成种子清单(worker 用 node 脚本算)

把 topsearch 的 json 存到临时文件,用 filter-lib.mjs 算种子:

```bash
# 把 topsearch json 写到 $TASK_OUTPUT_DIR/_topsearch.json
node -e "
import('file:///' + process.env.TASK_DIR + '/scripts/filter-lib.mjs').then(lib => {
  const fs = require('fs');
  const payload = JSON.parse(fs.readFileSync(process.env.TASK_OUTPUT_DIR + '/_topsearch.json','utf8'));
  const seeds = lib.buildInstagramSeedUrls(process.argv[1], payload).slice(0, 3);
  console.log(JSON.stringify(seeds));
})" "<keyword>"
```

拿到种子 URL 数组(最多 3 个:关键词页 + 精确 hashtag + 用户主页)。

### 6. 扫描每个种子(滚 + 收集帖子链接)

对每个种子 URL:
- navigate 到种子页
- 设配置:`window.__insSeedScrollConfig = { postsPerSeed: 36, maxRounds: 8, noNewLimit: 4, scrollDelta: 400, matchedBy: '<种子类型>' }`(matchedBy 用 keyword_search/hashtag/account)
- 读 `$TASK_DIR/scripts/seed-scroll.js` 全文,作为 `expression` 传给 `chrome_cdp evaluate`,**带 `timeoutMs: 120000`**(2 分钟上限,IG 慢)
- 返回值是本轮种子摘要(rounds/stoppedReason/seedLinkCount/totalDiscovered)。全量帖子链接在 `window.__insCollector.discoveredPosts`。

**注意:每个种子 navigate 会重置页面,dom-collector 会被销毁。要么每个种子前重新 inject dom-collector,要么在 worker 内存里累积 discoveredPosts(worker 拿到 dump 后存自己变量,下一个种子前重置页面 collector)。** 推荐做法:每个种子扫完后用 dump-result.js 取走本种子发现的链接存 worker 内存,然后下一个种子重新走 navigate + inject dom-collector。

### 7. 分块 dump 帖子清单(取所有种子发现的帖子链接)

```
for offset in 0, 50, 100, ... until hasMore === false:
  chrome_cdp action=evaluate expression="(() => { window.__insDumpConfig = { offset: <offset>, limit: 50 }; return <dump-result.js 全文作为 IIFE> })()" reason="..."
  // 返回 { posts: [{postUrl, matchedBy}], hasMore, totalDiscovered }
  累积进 worker 内存的 candidates 数组
```

记下 totalDiscovered(全量帖子链接数)。

### 8. 逐帖取详情(核心,优化版 — OG 优先 + 单 tab 复用)

**关键优化(2026 实测验证)**:IG 详情页的 `og:description` meta 标签在 **导航后 ~1s** 就到位(OG 在初始 HTML 里,不等 JS 渲染),且**含全部需要的字段**(点赞/评论/作者/日期/caption 全在一个 OG 字符串里)。**不要等完整渲染(6s),那浪费时间**。IG 已移除 `<script type="application/ld+json">`,不要依赖 ld+json。

**OG description 真实格式**(实测):
```
"6 likes, 1 comments -  medtrumofficial，December 12, 2025 : \"💪 caption 全文...\". "
   ↑ 点赞/评论         ↑ 作者(中文逗号，分隔)  ↑ 日期         ↑ caption 在引号里
```

**单 tab 复用**:worker 在**一个 tab** 里连续 navigate 各帖子(不开新 tab —— 开 tab 有 300-500ms 开销)。流程:

对 candidates(按 discoveredAtMs 排序,取前 maxResults=16 个)里每个帖子 URL,在同一 tab 里:

```
chrome_cdp action=navigate url=<帖子URL> reason="local Chrome CDP logged-in browser state for Instagram post detail" normalAccessAttempted=true
# 等 1.2s(OG 已到位;不用等 6s 完整渲染)
chrome_cdp action=evaluate expression="<一次性 extractPostDetail IIFE(见下)>" reason="local Chrome CDP logged-in browser state for Instagram post detail" normalAccessAttempted=true
```

**一次性 extractPostDetail IIFE**(直接传给 evaluate,不依赖常驻 collector;OG 优先,ld+json 作 fallback):

读 `$TASK_DIR/scripts/dom-collector.js`,**把里面的 `parseOgInline` + `extractPostDetail` 两个函数体**拼成一个自执行表达式传给 evaluate。简化版(OG 主路径):

```js
(() => {
  const clean = (v) => String(v||'').replace(/\s+/g,' ').trim();
  const og = clean(document.querySelector('meta[property="og:description"]')?.getAttribute('content')||'');
  // OG 解析(格式:"N likes, M comments - author，Date : \"caption\"")
  const likeMatch = og.match(/(\d[\d,]*)\s+likes?/i);
  const commentMatch = og.match(/(\d[\d,]*)\s+comments?/i);
  const authorMatch = og.match(/-\s+([^\s,，：:][^,，：]*?)\s*[,，：:]/);
  const captionMatch = og.match(/[""]([\s\S]*?)[""]\s*\.?\s*$/);
  let postedAt = '';
  if (authorMatch) {
    const afterAuthor = og.slice(authorMatch.index + authorMatch[0].length);
    const d = afterAuthor.match(/^\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})\s*:/);
    if (d) postedAt = d[1].trim();
  }
  return {
    url: location.href,
    author: authorMatch ? authorMatch[1].trim() : '',
    postedAt,  // 英文日期 "December 12, 2025",filter-lib 的 Date.parse 能识别
    caption: captionMatch ? captionMatch[1].trim() : '',
    likeCount: likeMatch ? parseInt(likeMatch[1].replace(/[^\d]/g,''),10) : null,
    commentCount: commentMatch ? parseInt(commentMatch[1].replace(/[^\d]/g,''),10) : null,
    metaDescription: og,
    redirectedToLogin: location.pathname.includes('/accounts/login'),
  };
})()
```

**重试一次**:若返回的 `author` 和 `postedAt` 都空(OG 还没到),再等 1s 重读一次。仍空则跳过该帖(计入 detailFailed)。

**完整流程**:`maxResults=16` 帖 × ~2s/帖(1.2s 等 + navigate/evaluate 开销)= **~35s 全量详情**(原方案 ~1.5 分钟,提速约 2.5 倍)。

### 9. 过滤 + 排序(worker 调 node 脚本)

把所有原始详情存到 `$TASK_OUTPUT_DIR/_raw_posts.json`,用 filter-lib 过滤:

```bash
node -e "
import('file:///' + process.env.TASK_DIR + '/scripts/filter-lib.mjs').then(lib => {
  const fs = require('fs');
  const raw = JSON.parse(fs.readFileSync(process.env.TASK_OUTPUT_DIR + '/_raw_posts.json','utf8'));
  const filtered = lib.selectRecentRelevantPosts(raw, { keyword: process.argv[1], days: parseInt(process.argv[2],10) });
  console.log(JSON.stringify(filtered));
})" "<keyword>" "<days>" > "$TASK_OUTPUT_DIR/_filtered.json"
```

### 10. 写输出文件

worker 读 `_filtered.json`,拼成下面结构,`fs.writeFileSync` 到 `$TASK_OUTPUT_DIR/ins_search_results.json`:

```json
{
  "platform": "Instagram",
  "keyword": "<原始 keyword>",
  "retrievedAt": "<ISO>",
  "queryUrl": "<第1步 build-url.mjs 输出的 URL>",
  "timeWindow": { "timePhrase": "<timePhrase>", "days": <days> },
  "benchmark": {
    "seedsScanned": <N>,
    "totalDiscovered": <N>,
    "detailFetched": <N>,
    "filteredRows": <filtered.length>,
    "stopReason": "<bottom_reached|no_new_links|max_rounds|posts_per_seed_reached>",
    "seeds": [ { "url":"...", "matchedBy":"...", "rounds":N, "seedLinkCount":N, "stoppedReason":"..." } ]
  },
  "results": [
    {
      "postedAt": "<ISO>",
      "author": "...",
      "titleDerived": "...",
      "caption": "...(完整原文)...",
      "likeCount": <N|null>,
      "commentCount": <N|null>,
      "matchReason": "<author|caption|title|url|seed>",
      "matchedBy": "<keyword_search|hashtag|account>",
      "url": "https://www.instagram.com/p/..."
    }
  ]
}
```

### 11. 收尾

最终回复只输出:输出文件路径 + 简短统计(seedsScanned / totalDiscovered / detailFetched / filteredRows / timeWindow.days)。**不要把 results 内容贴进回复** —— 全量已落文件。

## 边界

- IG 返回空:`results: []`,benchmark 照记,文件照写,verify 会过(空数组合法)。
- 登录墙:第 2 步检测到,`stopReason=login_required`,results 为空,文件照写。**不要编造结果。**
- topsearch API 失败(限流/登录):只用关键词搜索页作为唯一种子,继续扫。
- 帖子详情页重定向到登录:跳过该帖,计入 detailFetched 失败数。
- 单种子扫不出新链接(no_new_links):换下一个种子,不卡死。
