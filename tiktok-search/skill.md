# tiktok-search worker 执行手册

用 UGK 管理的 `chrome_cdp` 搜索 TikTok(滚动 `<main id="grid-main">` + 自动点重试按钮),按 `[now - days*24h, now]` 过滤,把完整结构化结果写入 `$TASK_OUTPUT_DIR/tiktok_search_results.json`。

## 工具就绪性(别写错层)

CDP 的启动/连接检查由 task 框架的 `requiredTools` 声明触发,**不要**在 worker 内写 `chrome_cdp status` 检查 → `chrome_cdp launch` → 重试。worker spawn 前机制已开好隔离 tab,进来直接用 `chrome_cdp navigate/evaluate` 即可。**特别提醒:不要用 host-bridge / proxy:3456 / Docker sidecar / web-access —— 这些是旧架构,已废弃,改用 chrome_cdp 工具。**

## 输入(全部已由 dispatcher 算好,worker 直接用)

从 `contract.runtimeInput` 读(都是扁平标量字段):
- `keyword`(必填):TikTok 搜索关键词,原样用于查询 URL 和过滤。
- `timePhrase`(必填):用户原始时间短语(任意语言),原样回显。
- `days`(必填):时间窗口天数(正整数)。dispatcher 已把"最近30天/上周/past month"算成具体天数。

**worker 不解析时间。** dispatcher 是 LLM,已经算好了。

**输入校验(开 Chrome 前必做):** 上述必填字段必须全部存在且是标量。**`days` 必须是正整数。** 若任一缺失/非标量/days 非法,直接报错退出,不要开 Chrome,不要现编默认值。

## 查询构造(调脚本,确定性,worker 不自己拼)

```bash
SEARCH_URL=$(node "$TASK_DIR/scripts/build-url.mjs" --keyword "<keyword>")
```

脚本输出 TikTok 搜索 URL,worker 直接 navigate 用。

## 执行流程

所有脚本在 `$TASK_DIR/scripts/`(环境变量 `TASK_DIR` 已注入)。

### 1. navigate 到搜索页

```
chrome_cdp action=navigate url=<SEARCH_URL> reason="local Chrome CDP logged-in browser state for TikTok search" normalAccessAttempted=true
```

### 2. 等页面加载 + 登录/限流检查

```
chrome_cdp action=evaluate expression="(() => { const t=document.title||''; const grid=document.getElementById('grid-main'); const videoLinks=document.querySelectorAll('a[href*=\"/video/\"]').length; const onLogin=/log\s*in|login/i.test(t); const blocked=/429|captcha|challenge/i.test(t); return { title:t, onLogin, blocked, hasGrid:!!grid, videoLinks }; })()" reason="local Chrome CDP logged-in browser state for TikTok search" normalAccessAttempted=true
```

- `onLogin=true` 或 `blocked=true` → 上报 login_required/blocked,不继续。
- `hasGrid && videoLinks>0` → 继续。
- 否则等几秒再检查(TikTok 渲染延迟;dom-collector 装好后 grid-scroll.js 会自动点重试按钮恢复)。

### 3. 装 DOM 收集器

读 `$TASK_DIR/scripts/dom-collector.js` 全文,作为 `expression` 传给 `chrome_cdp evaluate`。它装 `window.__tiktokCollector`(含 collect / clickRetryButtons / reset)+ 初始点击一次重试按钮。

### 4. 设滚动配置

```
chrome_cdp action=evaluate expression="(() => { window.__tiktokScrollConfig = { maxScrolls: 30, noNewThreshold: 6 }; return window.__tiktokScrollConfig; })()" reason="local Chrome CDP logged-in browser state for TikTok search" normalAccessAttempted=true
```

`maxScrolls` 可按需调高(活跃关键词 50-80),硬上限 100。`noNewThreshold` 默认 6(TikTok 分批加载需高容忍)。

### 5. 跑滚动主循环(长 evaluate)

读 `$TASK_DIR/scripts/grid-scroll.js` 全文,作为 `expression` 传给 `chrome_cdp evaluate`,**带 `timeoutMs: 180000`**(3 分钟上限,TikTok 慢 + 多轮重试)。

返回值是**摘要 + 预览**(小):`stoppedReason, actualScrolls, totalCollected, retriesClicked, preview(前50条)`。全量结果在 `window.__tiktokCollector.rows`。

- `stoppedReason=no_new_content` = 滚到底了(正常完成)
- `stoppedReason=max_scrolls` = 达到滚动上限(活跃话题,可重跑调高 maxScrolls)

记下 `totalCollected`(全量条数)。

### 6. 分块 dump 全量(核心落地)

循环调 dump-result.js,每次 offset += 50:

```
for offset in 0, 50, 100, ... until hasMore === false:
  chrome_cdp action=evaluate expression="(() => { window.__tiktokDumpConfig = { offset: <offset>, limit: 50 }; return <dump-result.js 全文作为 IIFE> })()" reason="local Chrome CDP logged-in browser state for TikTok search" normalAccessAttempted=true
  // 返回 { rows: [{url, author, desc, hashtags, createTime, likeCount}], hasMore, totalRows }
  累积进 worker 内存 candidates 数组
```

### 7. 取 raw + 过滤排序(两条 bash,worker 不碰 raw 内容)

**关键认知:worker 是 LLM agent,不是 node 进程** —— 唯一能落盘的是 `write` tool,逐 token 输出 raw 实测慢(同款 LLM 逐 token 病)。所以**严禁用 `write` tool 输出 raw**。

**第 7a 步:取 raw 落盘**(node 直连 CDP 循环 evaluate dump-result.js,读 `window.__tiktokCollector.rows` 全量写盘,<1s):

```bash
node "$TASK_DIR/scripts/collect-raw.mjs" --output "$TASK_OUTPUT_DIR/_raw_rows.json"
```

**第 7b 步:filter-lib 过滤排序**(读 `_raw_rows.json` bare array,输出 `_filtered.json`):

```bash
node -e "
import('file:///' + process.env.TASK_DIR + '/scripts/filter-lib.mjs').then(lib => {
  const fs = require('fs');
  const raw = JSON.parse(fs.readFileSync(process.env.TASK_OUTPUT_DIR + '/_raw_rows.json','utf8'));
  const filtered = lib.selectRecentRelevantVideos(raw, { keyword: process.argv[1], days: parseInt(process.argv[2],10) });
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
  --benchmark '{"stopReason":"<第5步返回>","actualScrolls":<N>,"maxScrolls":<N>,"totalCollected":<N>,"retriesClicked":<N>,"totalRunMs":<N>}' \
  --filtered "$TASK_OUTPUT_DIR/_filtered.json" \
  --output "$TASK_OUTPUT_DIR/tiktok_search_results.json"
```

脚本内部:读 `_filtered.json`(filter-lib `selectRecentRelevantVideos` 产物)→ `postedAt=createTimeToIso(createTime)`(import filter-lib,createTime=0 留空)→ 包 envelope → `JSON.stringify` → `writeFileSync` → round-trip 自检。产出结构:

```json
{
  "platform": "TikTok",
  "keyword": "<原始 keyword>",
  "retrievedAt": "<ISO>",
  "queryUrl": "<URL>",
  "timeWindow": { "timePhrase": "<timePhrase>", "days": <days> },
  "benchmark": {
    "stopReason": "<第5步返回>",
    "actualScrolls": <N>,
    "maxScrolls": <N>,
    "totalCollected": <N>,
    "filteredRows": <filtered.length>,
    "retriesClicked": <N>,
    "totalRunMs": <N>
  },
  "results": [
    {
      "postedAt": "<ISO,从 createTime 转换>",
      "author": "...",
      "desc": "...(完整描述)...",
      "hashtags": ["..."],
      "likeCount": <N|null>,
      "matchReason": "<desc|hashtag|author|multi-word>",
      "url": "https://www.tiktok.com/@user/video/123"
    }
  ]
}
```

`filteredRows` 字段脚本用 `_filtered.json` 实际长度填,worker 不用传。`benchmark` 参数:第 5 步 grid-scroll.js 返回值里的字段(stopReason/actualScrolls/maxScrolls/totalCollected/retriesClicked←totalRetriesClicked/totalRunMs)组装成 JSON 对象,单引号包裹传进。

### 9. 收尾

最终回复只输出:输出文件路径 + 简短统计(actualScrolls / totalCollected / filteredRows / retriesClicked / timeWindow.days)。**不要把 results 内容贴进回复** —— 全量已落文件。

## 边界

- TikTok 返回空:`results: []`,benchmark 照记,文件照写,verify 会过(空数组合法)。
- 登录墙/限流/captcha:第 2 步检测到,`stopReason=blocked`,results 为空,文件照写。**不要编造结果。**
- 重试按钮一直失败:grid-scroll.js 会点重试直到 noNewThreshold,仍无新内容则 `no_new_content` 停。
- createTime=0(日期解析失败):filter-lib 保留(让 verify 不强制要求 postedAt 非空),但 postedAt 字段为空字符串。
- 算法推荐排序导致新内容埋很深:grid-scroll.js 滚到底为止,用户可重跑调高 maxScrolls。
