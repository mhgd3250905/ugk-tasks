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

只注入 keyword(LinkedIn 已在服务端按 datePosted 过滤,worker 不需要本地时间过滤,也没有滚动轮数上限——滚到底为止):

```
chrome_cdp action=evaluate expression="(() => { window.__linkedinRunConfig = { keyword: '<keyword>' }; return window.__linkedinRunConfig; })()" reason="local Chrome CDP logged-in browser state for LinkedIn content search" normalAccessAttempted=true
```

### 5. 跑滚动采集(长 evaluate,滚到底为止)

读 `$TASK_DIR/scripts/scroll-and-collect.js` 全文,作为 `expression` 传给 `chrome_cdp evaluate`,**带 `timeoutMs: 300000`**(5 分钟上限;LinkedIn 慢 + 反爬,可能滚很多轮。脚本会自动判断到底:连续 5 轮双信号(页面高度停滞 AND 无新帖)均无进展 → bottom_reached)。

返回值是**摘要 + 预览**(小):`stoppedReason, scrollStatus{actualRounds,buttonClicks,totalDiscovered}, totalRows, rows(预览50条)`。全量结果在 `window.__linkedinCollector.rows`。
- `stoppedReason=bottom_reached` = 滚到底了(正常完成)
- `stoppedReason=login_required` = 遇到登录墙
- `stoppedReason=safety_cap_reached` = 200 轮安全上限(极少见,说明页面异常)

记下返回的 `totalRows`(全量条数),下一步分块数 = `ceil(totalRows / 50)`。**worker 不做时间过滤**(LinkedIn datePosted 已服务端过滤)。

### 6. 分块 dump 全量(核心落地)⚠️ 数据已经在 worker 手里,不要传输

**关键认知:worker 是 node 进程,有 fs。`chrome_cdp evaluate` 的返回值直接就是数据本身 —— 不需要从页面"传输"到 worker,不需要下载,不需要 HTTP 服务器。** 每次 evaluate 返回的那块 rows,直接在 worker 内存里累积进 results 数组。

循环调 dump-result.js,每次 offset += 50。读 `$TASK_DIR/scripts/dump-result.js` 全文,循环:

```
for offset in 0, 50, 100, ... until hasMore === false:
  chrome_cdp action=evaluate expression="(() => { window.__linkedinDumpConfig = { offset: <offset>, limit: 50 }; return <dump-result.js 全文作为 IIFE> })()" reason="local Chrome CDP logged-in browser state for LinkedIn content search" normalAccessAttempted=true
  // evaluate 的返回值直接就是 { ok, rows: [...50条...], hasMore, totalRows }
  // 把返回的 rows 直接 push 进 worker 内存里的 results 数组(在 node 进程内,不是页面里)
```

全部块累积完后,results 数组就在 worker 内存里,下一步直接 `fs.writeFileSync` 写到 $TASK_OUTPUT_DIR。

**🚫 严禁的数据落地方式(都是错误心智模型,会触发弹窗/失败):**
- ❌ **不要触发浏览器下载**(createObjectURL/a.click/saveAs/导出)—— 数据不在页面,在 worker 手里
- ❌ **不要启动本地 HTTP 服务器让页面 POST**(save-server 方案)—— worker 有 fs,不需要传输
- ❌ **不要用 sendBeacon / fetch 从页面往外传**—— 数据已经通过 evaluate 返回值到了 worker
- ❌ **不要找"下载文件再复制"**—— 根本不该有下载产生

worker 是 node 进程,唯一正确的落地方式是 `fs.writeFileSync`(下一步第 7 步)。

### 7. 写输出文件

把第 5 步的 benchmark、第 6 步累积(在 worker 内存里)的完整 results 数组,拼成下面结构,**用 worker 自己的 node `fs.writeFileSync`**(不是浏览器端!)写到 `$TASK_OUTPUT_DIR/linkedin_search_results.json`:

```json
{
  "platform": "LinkedIn",
  "keyword": "<原始 keyword>",
  "retrievedAt": "<ISO>",
  "queryUrl": "<第0步 build-url.mjs 输出的 URL>",
  "timeWindow": { "timePhrase": "<timePhrase>", "dateRange": "<dateRange>" },
  "benchmark": {
    "stopReason": "<第5步 scrollStatus.stoppedReason>",
    "scrollRounds": <actualRounds>,
    "totalDiscovered": <totalDiscovered>,
    "buttonClicks": <buttonClicks>,
    "inWindow": <results.length>
  },
  "results": [
    { "postedAtLabel": "...", "postedAt": "<解析出的ISO或空>", "url": "...", "content": "...(完整原文)...", "authorName": "...", "authorHandle": "..." }
  ]
}
```

字段说明:`postedAt` = 把 postedAtLabel 解析成 ISO(解析不出则留空);`content` 保留原文;`authorHandle` 必须是 `/in/` 或 `/company/` 链接。

### 8. 收尾

最终回复只输出:输出文件路径 + 简短统计(stopReason / scrollRounds / totalDiscovered / inWindow / timeWindow.dateRange)。**不要把 results 内容贴进回复** —— 全量已落文件,回复只给路径。

## 边界

- LinkedIn 返回空:`results: []`,benchmark 照记,文件照写,verify 会过(空数组合法)。
- 登录墙/captcha:第 2 步或第 5 步会检测到,`stopReason=login_required`,results 为空,文件照写(带 preflight 失败标记)。**不要编造结果。**
- scroll 到底无新内容:scroll-and-collect.js 的 bounce 机制会自动处理,4 轮 stale 后停(`bottom_reached`)。
