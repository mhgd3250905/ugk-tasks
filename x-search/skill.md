# x-search worker 执行手册

用 UGK 管理的 `chrome_cdp` 搜索 X/Twitter Latest,按 `[startIso, endIso)` 过滤,把完整结构化结果写入 `$TASK_OUTPUT_DIR/x_search_results.json`。

## 工具就绪性(别写错层)

CDP 的启动/连接检查由 task 框架的 `requiredTools` 声明触发,**不要**在 worker 内写 `chrome_cdp status` 检查 → `chrome_cdp launch` → 重试。worker spawn 前机制已开好隔离 tab,进来直接用 `chrome_cdp navigate/evaluate` 即可。

## 输入(全部已由 dispatcher 算好,worker 直接用)

从 `contract.runtimeInput` 读(都是扁平标量字段,不是嵌套对象):
- `keyword`(必填):X 搜索关键词,原样用于查询 URL。
- `timePhrase`(必填):用户原始时间短语(任意语言),原样回显。
- `timeMode`(必填):`rolling` | `calendar` | `calendar_to_now`
- `timeAmount`(必填):正数(数量)
- `timeUnit`(必填):`hour` | `day` | `week` | `month`
- `startIso`(必填):窗口起 ISO(含)
- `endIso`(必填):窗口止 ISO(排他=now)
- `canonical`(必填):`"<N>hours"` 或 `"<N>days"`
- `maxSteps`(可选,默认 20):滚动上限。

**worker 不解析时间、不调时间解析脚本。** dispatcher 是 LLM,已经把"俩月/上周/last week"算成 startIso/endIso 了。

**输入校验(开 Chrome 前必做):** 上述必填字段必须全部存在且是标量(string/number)。**若任一缺失或不是标量(如被截断成字符串),直接报错退出,不要开 Chrome,不要现编默认时间值。** 这是 dispatcher 失败的信号,现编会产出错误结果。

### 组装 timeWindow 对象(写输出时用)

worker 把扁平字段组装成 timeWindow 对象,写进输出 JSON:
```json
{ "raw": "<timePhrase>", "mode": "<timeMode>", "amount": <timeAmount>, "unit": "<timeUnit>", "startIso": "<startIso>", "endIso": "<endIso>", "canonical": "<canonical>" }
```

## 查询构造

```text
https://x.com/search?q=<encodeURIComponent(keyword)>&src=typed_query&f=live
```

只编码 keyword 本身。保留用户原始 keyword 进查询。

## 执行流程

所有脚本在 `$TASK_DIR/scripts/`(环境变量 `TASK_DIR` 已注入)。**读脚本内容传给 `chrome_cdp evaluate`** —— 不要在 worker 里复刻脚本逻辑。

### 1. navigate

```
chrome_cdp action=navigate url=<上面构造的 X Latest URL> reason="local Chrome CDP logged-in browser state for X/Twitter search" normalAccessAttempted=true
```

tab 不用指定(worker 已分到隔离 tab,默认 target)。

### 2. 等页面加载

```
chrome_cdp action=evaluate expression="(() => ({ title: document.title, hasArticles: document.querySelectorAll('article').length, href: location.href }))()" reason="local Chrome CDP logged-in browser state for X/Twitter search" normalAccessAttempted=true
```

`hasArticles > 0` 再继续。若 `title`/页面文本显示登录墙、限流、错误,按 `spec` 的 stopReason 上报,别硬滚。

### 3. 装 DOM 收集器

读 `$TASK_DIR/scripts/dom-collector.js` 全文,作为 `expression` 传给 `chrome_cdp evaluate`(默认 timeout 即可)。它装 `window.__xSearcherDom` + MutationObserver。

### 4. 设运行配置(把 dispatcher 算好的扁平时间字段注入页面)

```
chrome_cdp action=evaluate expression="(() => { window.__xSearcherRunConfig = { keyword: '<keyword>', startIso: '<startIso>', cutoffIso: '<startIso>', endIso: '<endIso>', rangeLabel: '<canonical>', maxSteps: <maxSteps>, returnRowsLimit: 50, collectorMaxRows: 1000 }; return window.__xSearcherRunConfig; })()" reason="local Chrome CDP logged-in browser state for X/Twitter search" normalAccessAttempted=true
```

`startIso`/`endIso`/`canonical` 直接用 runtime input 的扁平字段值。注意:所有字符串要安全 JSON stringify 后再拼表达式,不要手写引号导致关键词或中文破坏 JS。

### 5. 跑 anchor-overlap 滚动(长 evaluate)

读 `$TASK_DIR/scripts/anchor-scroll.js` 全文,作为 `expression` 传给 `chrome_cdp evaluate`,**带 `timeoutMs: 90000`**(或更大,工具钳位到 1s-5min)。

返回值是**摘要 + 预览**(小):`stopReason, cutoffReached, score, grade, anchorScrolls, rowsInspected, validRows, filteredRows, rows(预览50条)`。全量定型结果已存在页面的 `window.__xSearcherLastResult`。

`anchor-scroll.js` 会按 `[startIso, endIso)` 过滤(双边界)——上周会排除本周内容,并继续滚到早于上周开始。

记下返回的 `filteredRows`(全量条数),下一步分块数 = `ceil(filteredRows / 50)`。

### 6. 分块 dump 全量(核心落地)

循环调 dump-result.js,每次 offset += 50。**每块立即拼进最终 JSON,不截断单条原文。**

读 `$TASK_DIR/scripts/dump-result.js` 全文,循环:

```
for offset in 0, 50, 100, ... until hasMore === false:
  chrome_cdp action=evaluate expression="(() => { window.__xSearcherDumpConfig = { source: 'rows', offset: <offset>, limit: 50 }; return <dump-result.js 全文作为 IIFE> })()" reason="local Chrome CDP logged-in browser state for X/Twitter search" normalAccessAttempted=true
  // 返回 { ok, rows: [{index, postedAt, url, content, authorName, authorHandle}], hasMore, totalRows }
  把这 50 条累积进 results 数组
```

注意:dump-result.js 本身是 IIFE,可直接作为 expression;config 要在**同一个 evaluate 表达式里**先设好。

`source` 默认 `'rows'`(时间窗口内 + 关键词命中的过滤后全集),够交付。用户若显式要含范围外原始数据,设 `source: 'allRows'`。

### 7. 写输出文件

把扁平字段组装成的 timeWindow 对象(见"输入"段)、第 5 步的 benchmark、第 6 步累积的完整 results,拼成下面结构,`fs.writeFileSync` 到 `$TASK_OUTPUT_DIR/x_search_results.json`:

```json
{
  "rawQuery": "<原始 keyword>",
  "normalizedKeyword": "<keyword>",
  "timeWindow": { "raw": "<timePhrase>", "mode": "<timeMode>", "amount": <timeAmount>, "unit": "<timeUnit>", "startIso": "<startIso>", "endIso": "<endIso>", "canonical": "<canonical>" },
  "cutoffIso": "<startIso>",
  "retrievedAt": "<ISO>",
  "searchUrl": "https://x.com/search?q=<encoded>&src=typed_query&f=live",
  "method": "x-search taskbook / DOM fallback with MutationObserver + anchor-overlap scrolling / local Chrome CDP",
  "benchmark": {
    "stopReason": "<第5步返回>",
    "cutoffReached": <bool>,
    "score": <N>,
    "grade": "<A-D>",
    "anchorScrolls": <N>,
    "maxSteps": <N>,
    "rowsInspected": <N>,
    "validRows": <N>,
    "filteredRows": <N>,
    "rowsReturned": <results.length>,
    "validRate": <0-1>,
    "keywordMatchRate": <0-1>,
    "totalRunMs": <N>
  },
  "results": [ { "postedAt": "...", "text": "...(完整原文)...", "url": "...", "author": "<authorName>", "handle": "<authorHandle>" }, ... ]
}
```

字段映射:`results[].text` = row 的 `content`(不截断);`author` = `authorName`;`handle` = `authorHandle`。

### 8. 收尾

最终回复只输出:输出文件路径 + 简短统计(rowsReturned / score / grade / stopReason / timeWindow.canonical)。**不要把 results 内容贴进回复** —— 全量已落文件,回复只给路径。

## 边界

- X 返回空:`results: []`,benchmark 照记,文件照写,verify 会过(空数组合法)。
- 登录墙/限流/错误:`stopReason` 记相应值,`results` 为已收集部分,文件照写。
- maxSteps 到顶但没到 cutoff:照写,benchmark.grade 偏低,标 partial。用户可重跑提高 maxSteps。
