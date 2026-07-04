# reddit-search worker 执行手册

用 UGK 管理的 `chrome_cdp` 在登录态下搜索 Reddit(SSR 搜索页,`t` 参数服务端过滤时间),滚动加载全量,把结构化结果写入 `$TASK_OUTPUT_DIR/reddit_search_results.json`。

## 为什么用 CDP 而不是 API

Reddit 2026 年强制 OAuth,匿名 `.json`/`.rss` 端点不稳(反爬返回 HTML)。但**登录态 CDP 访问 SSR 搜索页正常**,且搜索结果数据(标题/subreddit/ISO 时间/votes/comments)直接服务端渲染进 DOM,不需要调 API。这比 OAuth 注册 app + GraphQL 更简单、更稳。

## 工具就绪性(别写错层)

CDP 的启动/连接检查由 task 框架的 `requiredTools` 声明触发,**不要**在 worker 内写 `chrome_cdp status` 检查 → `chrome_cdp launch` → 重试。worker spawn 前机制已开好隔离 tab,进来直接用 `chrome_cdp navigate/evaluate` 即可。

## 输入(全部已由 dispatcher 算好,worker 直接用)

从 `contract.runtimeInput` 读(都是扁平标量字段):
- `keyword`(必填):Reddit 搜索关键词,原样用于查询 URL。
- `timePhrase`(必填):用户原始时间短语(任意语言),原样回显。
- `days`(必填):时间窗口天数(正整数)。dispatcher 已把"最近一周/过去一个月"算成具体天数。

**worker 不解析时间。** dispatcher 是 LLM,已经算好了。

**输入校验(开 Chrome 前必做):** 上述必填字段必须全部存在且是标量。**`days` 必须是正整数。** 若任一缺失/非标量,直接报错退出,不要开 Chrome。

## 查询构造(调脚本,确定性,worker 不自己拼)

```bash
# 先用 filter-lib 把 days 映射成 Reddit 档位
TIME_RANGE=$(node -e "import('file:///' + process.env.TASK_DIR.replace(/\\\\/g,'/') + '/scripts/filter-lib.mjs').then(lib => console.log(lib.mapDaysToTimeRange(parseInt(process.argv[1],10))))" "<days>")
# 再用 build-url.mjs 生成完整 URL
SEARCH_URL=$(node "$TASK_DIR/scripts/build-url.mjs" --keyword "<keyword>" --timeRange "$TIME_RANGE")
```

`TIME_RANGE` 是 `hour`/`day`/`week`/`month`/`year`/`all` 之一。`SEARCH_URL` 形如:
```
https://www.reddit.com/search/?q=medtrum&sort=new&t=week
```

## 执行流程

所有脚本在 `$TASK_DIR/scripts/`(环境变量 `TASK_DIR` 已注入)。

### 1. navigate 到搜索页

```
chrome_cdp action=navigate url=<SEARCH_URL> reason="local Chrome CDP logged-in browser state for Reddit keyword search" normalAccessAttempted=true
```

### 2. 等页面加载 + 登录态检查

```
chrome_cdp action=evaluate expression="(() => ({ title: document.title, blocked: /429|captcha|challenge|blocked/i.test(document.title||''), href: location.href, commentLinks: document.querySelectorAll('a[href*=\"/comments/\"]').length }))()" reason="local Chrome CDP logged-in browser state for Reddit keyword search" normalAccessAttempted=true
```

- `blocked=true` → 上报 blocked(被反爬/限流),不继续。
- `commentLinks > 0` → 继续(SSR 已渲染帖子)。
- 否则等几秒再检查一次(Reddit 渲染有延迟)。

### 3. 装 DOM 收集器

读 `$TASK_DIR/scripts/dom-collector.js` 全文,作为 `expression` 传给 `chrome_cdp evaluate`。它装 `window.__redditCollector`(含 record/reset),从 `<h2> a[href*=/comments/]` 抽帖子(标题/permalink/subreddit/ISO 时间/votes 文本)。

### 4. 设滚动配置

```
chrome_cdp action=evaluate expression="(() => { window.__redditScrollConfig = { maxRounds: 30, maxStale: 5, maxPosts: 200 }; return window.__redditScrollConfig; })()" reason="local Chrome CDP logged-in browser state for Reddit keyword search" normalAccessAttempted=true
```

### 5. 跑滚动主循环(长 evaluate)

读 `$TASK_DIR/scripts/scroll-and-collect.js` 全文,作为 `expression` 传给 `chrome_cdp evaluate`,**带 `timeoutMs: 180000`**(3 分钟上限)。

返回值:`stoppedReason, rounds, totalPosts, totalRunMs`。全量结果在 `window.__redditCollector.posts`。

- `stoppedReason=bottom_reached` = 滚到底(正常完成)
- `stoppedReason=max_rounds` = 达到轮数上限(活跃话题,可重跑调高 maxRounds)

记下 `totalPosts`(全量条数)。

### 6. 分块 dump 全量

循环调 dump-result.js,每次 offset += 50:

```
for offset in 0, 50, 100, ... until hasMore === false:
  chrome_cdp action=evaluate expression="(() => { window.__redditDumpConfig = { offset: <offset>, limit: 50 }; return <dump-result.js 全文作为 IIFE>; })()" reason="local Chrome CDP logged-in browser state for Reddit keyword search" normalAccessAttempted=true
  // 返回 { posts: [{permalink, title, subreddit, postedAt, author, scoreText, bodyText}], hasMore, totalPosts }
  累积进 worker 内存
```

### 7. 取 raw + 归一化去重(两条 bash,worker 不碰 raw 内容)

**关键认知:worker 是 LLM agent,不是 node 进程** —— 唯一能落盘的是 `write` tool,逐 token 输出 87 条 raw 实测 ~4min(慢 + JSON 易错)。所以**严禁用 `write` tool 输出 raw**。

**第 7a 步:取 raw 落盘**(node 直连 CDP 循环 evaluate dump-result.js,读 `window.__redditCollector.posts` 全量写盘,<1s):

```bash
node "$TASK_DIR/scripts/collect-raw.mjs" --output "$TASK_OUTPUT_DIR/_raw.json"
```

**第 7b 步:filter-lib 归一化 + 去重**(读 `_raw.json` bare array,输出 `_filtered.json`):

```bash
node -e "
import('file:///' + process.env.TASK_DIR.replace(/\\\\/g,'/') + '/scripts/filter-lib.mjs').then(lib => {
  const fs = require('fs');
  const raw = JSON.parse(fs.readFileSync(process.env.TASK_OUTPUT_DIR + '/_raw.json','utf8'));
  const norm = raw.map(p => lib.normalizeRedditPost(p)).filter(Boolean);
  const filtered = lib.selectPosts(norm, { keyword: process.argv[1], days: parseInt(process.argv[2],10) });
  console.log(JSON.stringify(filtered));
})" "<keyword>" "<days>" > "$TASK_OUTPUT_DIR/_filtered.json"
```

### 8. 写输出文件(单条 bash,worker 不碰 results 内容)

**关键认知:worker 是 LLM agent,不是 node 进程** —— 唯一能落盘的是 `write` tool,它会逐 token 输出整个 JSON(实测同体量 +124s,且 LLM 手拼 JSON 易转义错)。所以**严禁用 `write` tool 输出 results**。

正确做法:bash 调 `scripts/write-output.mjs`,它读 `_filtered.json` + `JSON.stringify` + `writeFileSync`(确定性、<1s、JSON 保证合法)。worker 只把第 5 步的 benchmark、keyword/timePhrase/days、queryUrl 作为**小参数**传进去:

```bash
node "$TASK_DIR/scripts/write-output.mjs" \
  --keyword "<原始 keyword>" \
  --timePhrase "<timePhrase>" \
  --days <days> \
  --queryUrl "<第1步 build-url.mjs 输出的 URL>" \
  --benchmark '{"stopReason":"<第5步返回>","rounds":<N>,"maxRounds":<N>,"totalCollected":<N>,"totalRunMs":<N>}' \
  --filtered "$TASK_OUTPUT_DIR/_filtered.json" \
  --output "$TASK_OUTPUT_DIR/reddit_search_results.json"
```

脚本内部:读 `_filtered.json`(filter-lib `selectPosts` 产物)→ 丢 postId → `timeRange=mapDaysToTimeRange(days)`(import filter-lib)→ 包 envelope → `JSON.stringify` → `writeFileSync` → round-trip 自检。产出结构:

```json
{
  "platform": "Reddit",
  "keyword": "<原始 keyword>",
  "retrievedAt": "<ISO>",
  "queryUrl": "<URL>",
  "timeWindow": { "timePhrase": "<timePhrase>", "days": <days>, "timeRange": "<hour|day|week|month|year|all>" },
  "benchmark": {
    "stopReason": "<第5步返回>",
    "rounds": <N>,
    "maxRounds": <N>,
    "totalCollected": <raw 总数>,
    "filteredRows": <filtered.length>,
    "totalRunMs": <N>
  },
  "results": [
    {
      "postedAt": "<ISO>",
      "title": "...",
      "subreddit": "<无 r/ 前缀>",
      "author": "<可能空>",
      "score": <N>,
      "numComments": <N>,
      "selftext": "<列表页通常空>",
      "permalink": "https://www.reddit.com/r/xxx/comments/yyy/"
    }
  ]
}
```

`filteredRows` 字段脚本用 `_filtered.json` 实际长度填。`benchmark` 参数:第 5 步 scroll-and-collect.js 返回值(stopReason←stoppedReason/rounds/totalCollected←totalPosts/totalRunMs)+ maxRounds(来自配置)组装成 JSON 对象,单引号包裹传进。

### 9. 收尾

最终回复只输出:输出文件路径 + 简短统计(rounds / totalCollected / filteredRows / timeWindow.timeRange)。**不要把 results 内容贴进回复**。

## 边界

- Reddit 返回空:`results: []`,benchmark 照记,文件照写,verify 会过(空数组合法)。
- 被反爬/限流/登录失效:第 2 步检测到 `blocked=true` 或 commentLinks=0,`stopReason=blocked`,results 为空。**不要编造结果。**
- 滚到底无新内容:scroll-and-collect.js 连续 5 轮 stale 自动停(`bottom_reached`)。
- author 列表页通常没有(要点进详情):接受 author 为空。
- selftext 列表页只有标题:接受 selftext 为空。
