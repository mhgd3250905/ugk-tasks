# linkedin-search worker 执行手册

用 UGK 管理的 `chrome_cdp` 搜索 LinkedIn 内容(过去 N 天,按发布时间倒序),按 `[startIso, endIso)` 过滤,把完整结构化结果写入 `$TASK_OUTPUT_DIR/linkedin_search_results.json`。

## 工具就绪性(别写错层)

CDP 的启动/连接检查由 task 框架的 `requiredTools` 声明触发,**不要**在 worker 内写 `chrome_cdp status` 检查 → `chrome_cdp launch` → 重试。worker spawn 前机制已开好隔离 tab,进来直接用 `chrome_cdp navigate/evaluate` 即可。**特别提醒:不要用 host-bridge / proxy:3456 / Docker sidecar / web-access —— 这些是旧架构,已废弃,改用 chrome_cdp 工具。**

## 输入(全部已由 dispatcher 算好,worker 直接用)

从 `contract.runtimeInput` 读(都是扁平标量字段):
- `keyword`(必填):LinkedIn 搜索关键词,原样用于查询 URL。
- `timePhrase`(必填):用户原始时间短语(任意语言),原样回显。
- `dateRange`(必填):LinkedIn 原生时间档位,三选一:`past-24h` | `past-week` | `past-month`。dispatcher 已把用户时间意图归并到覆盖它的最近档位。

**worker 不解析时间、不换算档位、不构造 URL。** dispatcher 只管 keyword + dateRange,URL 由 `build-url.mjs` 脚本确定性生成。

**输入校验(开 Chrome 前必做):** 上述必填字段必须全部存在且是标量。**`dateRange` 必须是 `past-24h`/`past-week`/`past-month` 三者之一**(LinkedIn 只支持这三档,不自造其他值)。**若任一缺失/非标量/dateRange 非法,直接报错退出,不要开 Chrome,不要现编默认值。**

## 查询构造(调脚本,确定性,worker 不自己拼)

**worker 不要自己拼 URL(容易漏 sortBy/datePosted 参数)。用脚本拿:**

```bash
SEARCH_URL=$(node "$TASK_DIR/scripts/build-url.mjs" --keyword "<keyword>" --dateRange <dateRange>)
```

脚本输出完整的 LinkedIn 内容搜索 URL(含 sortBy=date_posted 按最新排序 + datePosted 时间档位过滤),worker 直接 navigate 用。脚本内部校验 dateRange 三档合法性(非法兜底 past-week)。

**例子**:`build-url.mjs --keyword medtrum --dateRange past-month` 输出:
```
https://www.linkedin.com/search/results/content/?keywords=medtrum&origin=FACETED_SEARCH&sortBy=%5B%22date_posted%22%5D&datePosted=%5B%22past-month%22%5D
```

LinkedIn 的 datePosted 已在服务端按三档过滤,worker **不需要本地再做时间过滤**(拿到的就是档位内的结果)。

## 执行流程

所有脚本在 `$TASK_DIR/scripts/`(环境变量 `TASK_DIR` 已注入)。

### 0. 构造 URL(调脚本)

```bash
SEARCH_URL=$(node "$TASK_DIR/scripts/build-url.mjs" --keyword "<keyword>" --dateRange <dateRange>)
echo "$SEARCH_URL"  # 确认含 sortBy 和 datePosted 两个参数
```

### 1. navigate

```
chrome_cdp action=navigate url=<SEARCH_URL> reason="local Chrome CDP logged-in browser state for LinkedIn content search" normalAccessAttempted=true
```

tab 不用指定(worker 已分到隔离 tab,默认 target)。

### 2. 等页面加载 + 登录检查

```
chrome_cdp action=evaluate expression="(() => { const t=document.title||''; const onLogin=/登录|sign\\s*in/i.test(t)||location.pathname.includes('/login')||location.pathname.includes('/checkpoint'); const captcha=/captcha|recaptcha|challenge|验证/i.test(t)||location.hostname.includes('recaptcha')||location.hostname.includes('protechts'); const container=document.querySelector('#workspace')||document.querySelector('main'); const authors=document.querySelectorAll('a[href*=\"/in/\"],a[href*=\"/company/\"]').length; return { title:t, onLogin, captcha, hasContainer:!!container, authors }; })()" reason="local Chrome CDP logged-in browser state for LinkedIn content search" normalAccessAttempted=true
```

- `onLogin=true` 或 `captcha=true` → 直接上报 login_required/captcha,不要继续(不编造结果)
- `hasContainer && authors>0` → 继续
- 否则等几秒再检查一次(LinkedIn 渲染有延迟)

### 3. 装 DOM 收集器

读 `$TASK_DIR/scripts/dom-collector.js` 全文,作为 `expression` 传给 `chrome_cdp evaluate`(默认 timeout)。它装 `window.__linkedinCollector`(含 recordVisible + 三级 URL 优先级 + 作者名回退 + 相对时间解析)。

### 4. 设运行配置

注入 keyword(LinkedIn 已在服务端按 datePosted 过滤,worker 的职责是把过滤后的结果**全部滚出来**):

```
chrome_cdp action=evaluate expression="(() => { window.__linkedinRunConfig = { keyword: '<keyword>' }; return window.__linkedinRunConfig; })()" reason="local Chrome CDP logged-in browser state for LinkedIn content search" normalAccessAttempted=true
```

> ⚠️ **不要设小的 maxRows/hardCap**。LinkedIn past-month 内容多时需要 100+ 轮才能滚到底(实测 117 轮收 47 条属正常)。脚本默认 `maxRows:500 / hardCap:300` 是极端安全网,正常情况不该触发,靠 `bottom_reached` 停。

### 5. 跑滚动采集(长 evaluate,滚到底为止)

读 `$TASK_DIR/scripts/scroll-and-collect.js` 全文,作为 `expression` 传给 `chrome_cdp evaluate`,**带 `timeoutMs: 480000`**(8 分钟上限)。

返回值是**摘要 + 预览**(小):`stoppedReason, scrollStatus{actualRounds,buttonClicks,totalDiscovered}, totalRows, rows(预览50条)`。全量结果在 `window.__linkedinCollector.rows`。
- `stoppedReason=bottom_reached` = 连续 5 轮(高度停滞 AND 无新帖)→ **真到底了(正常完成,应走这条)**
- `stoppedReason=login_required` = 遇到登录墙
- `stoppedReason=safety_cap_reached` = 300 轮安全上限(罕见,说明页面异常死循环)
- `stoppedReason=max_rows_reached` = 500 条上限(罕见,说明被反爬灌水)

> ⚠️ **正常情况必须是 `bottom_reached`**。若返回 `safety_cap_reached` 或 `max_rows_reached`,说明没滚到底就被安全网截断了 —— 检查是不是脚本异常或反爬持续灌水,而不是把这当正常。

记下返回的 `scrollStatus` 对象(下一步作为 benchmark 传给落地脚本)。**worker 不做时间过滤**(LinkedIn datePosted 已服务端过滤)。

### 6. 取数 + 落地(单条 bash,worker 不碰 rows 内容)

**关键认知:worker 是 LLM agent,不是 node 进程** —— 唯一能落盘的是 `write` tool,它会逐 token 输出整个 JSON(实测 33KB 花 +124s,且 LLM 手拼 JSON 易转义错)。所以**严禁用 `write` tool 输出 results**。

正确做法:bash 调 `scripts/collect-and-write.mjs`,它自己直连 CDP 取 rows + `JSON.stringify` + `writeFileSync`(确定性、<1s、JSON 保证合法)。worker 只把第 0 步的 queryUrl、第 5 步的 scrollStatus、keyword/timePhrase/dateRange 作为**小参数**传进去(rows 内容完全不经过 worker):

```bash
node "$TASK_DIR/scripts/collect-and-write.mjs" \
  --keyword "<原始 keyword>" \
  --timePhrase "<timePhrase>" \
  --dateRange <past-24h|past-week|past-month> \
  --queryUrl "<第0步 build-url.mjs 输出的 URL>" \
  --benchmark '<第5步 scrollStatus 对象的 JSON>' \
  --output "$TASK_OUTPUT_DIR/linkedin_search_results.json"
```

脚本内部:循环 `chrome_cdp evaluate dump-result.js`(offset+=100,复用当前 LinkedIn tab)取全量 rows → 组装 envelope → `JSON.stringify` → `writeFileSync` → round-trip 自检。产出结构:

```json
{
  "platform": "LinkedIn",
  "keyword": "<原始 keyword>",
  "retrievedAt": "<ISO>",
  "queryUrl": "<URL>",
  "timeWindow": { "timePhrase": "<timePhrase>", "dateRange": "<dateRange>" },
  "benchmark": {
    "stopReason": "<stoppedReason>",
    "scrollRounds": <actualRounds>,
    "totalDiscovered": <totalDiscovered>,
    "buttonClicks": <buttonClicks>,
    "inWindow": <results.length>
  },
  "results": [
    { "postedAtLabel": "...", "postedAt": "<ISO或空>", "url": "...", "content": "...(完整原文)...", "authorName": "...", "authorHandle": "..." }
  ]
}
```

`benchmark` 参数:把第 5 步返回的 `scrollStatus` 对象(含 stoppedReason/actualRounds/totalDiscovered/buttonClicks)整体 `JSON.stringify` 后作为 `--benchmark` 的值传进(单引号包裹,bash 安全)。脚本会映射字段名(`stoppedReason→stopReason`、`actualRounds→scrollRounds` 等)。

**🚫 严禁:** 用 `write` tool 输出 results(慢 + JSON 易错);触发浏览器下载;启 HTTP 服务器传数据(数据已通过 CDP 到了 node,无需传输)。

### 7. 收尾

最终回复只输出:输出文件路径 + 简短统计(stopReason / scrollRounds / totalDiscovered / inWindow / timeWindow.dateRange)。**不要把 results 内容贴进回复** —— 全量已落文件,回复只给路径。

## 边界

- LinkedIn 返回空:`results: []`,benchmark 照记,文件照写,verify 会过(空数组合法)。
- 登录墙/captcha:第 2 步或第 5 步会检测到,`stopReason=login_required`,results 为空,文件照写(带 preflight 失败标记)。**不要编造结果。**
- scroll 到底无新内容:scroll-and-collect.js 的 bounce 机制会自动处理,4 轮 stale 后停(`bottom_reached`)。
