# ugk-tasks

[UGK](https://github.com/mhgd3250905/ugk-tui) `/task` taskbook 集合。三类能力:**配音流水线**(视频→字幕→翻译→配音→合成)、**社媒关键词搜索**(X/LinkedIn/Instagram/TikTok/Reddit,关键词 + 时间范围)和**糖尿病新闻汇报链路**(多源采集→翻译→HTML 报告)。全部经 worker 真跑 + verify 验证。

## 包含的 taskbook

### 配音流水线(视频处理)

| taskbook | 作用 | 流水线位置 |
|---|---|---|
| `video-downloader` | yt-dlp 下载公开视频,智能选分辨率/字幕 | 前置:获取源视频 |
| `whisper-audio-to-text` | Whisper large-v3-turbo 转写音视频为 SRT/VTT/TXT | 流水线第 1 步 |
| `subtitle-cleaner` | 字幕清洗(去音效标记/回声碎片/重叠,格式归一) | 流水线第 2 步 |
| `subtitle-fluent-translator` | LLM 翻译+断句重排为流畅中文字幕 | 流水线第 3 步 |
| `subtitle-to-speech` | MiMo TTS 生成按字幕时间轴的中文配音(6 路并发) | 流水线第 4 步 |
| `video-zh-composer` | 三流合成(视频+配音+字幕)为软/硬字幕 MP4 | 流水线第 5 步 |

### 社媒关键词搜索(CDP + 时间范围)

| taskbook | 平台 | 数据源 | 时间过滤 |
|---|---|---|---|
| `x-search` | X / Twitter | 登录态 CDP + Latest tab + anchor-overlap 滚动 | `[startIso, endIso)` 双边界 |
| `linkedin-search` | LinkedIn | 登录态 CDP + 内容搜索(三档 dateRange) | LinkedIn 原生 `past-24h/week/month` |
| `ins-search` | Instagram | 登录态 CDP + 多种子(hashtag/用户主页)+ OG meta 详情 | `days` 天窗口 |
| `tiktok-search` | TikTok | 登录态 CDP + `#grid-main` 滚动 + 重试按钮 | `days` 天窗口 |
| `reddit-search` | Reddit | 登录态 CDP + SSR DOM(Reddit 2026 强制 OAuth,匿名 .json/.rss 已废弃) | Reddit 原生 `t=hour/day/week/month/year/all` |

> 搜索类 taskbook 全部依赖**本地登录态 Chrome**(CDP)。Reddit 因 2026-05-28 起强制 OAuth、匿名端点全反爬,改走登录态 SSR DOM 抽取(无需注册 app)。

### 糖尿病新闻汇报链路(JSON → 翻译 → HTML)

| taskbook | 作用 | 输出 |
|---|---|---|
| `medical-diabetes-news` | RSS/sitemap/simple HTTP 采集糖尿病医学与器械新闻 | `medical_diabetes_news.json` |
| `diabetes-device-regulatory-signals` | FDA/MAUDE/召回/安全通告等监管信号采集 | `diabetes_device_regulatory_signals.json` |
| `diabetes-device-custom-source-news` | Sequel/Senseonics/Dexcom/Insulet/MassDevice/MobiHealthNews 自定义源采集 | `diabetes_device_custom_source_news.json` |
| `diabetes-news-report-translator` | 对上游 JSON 中需要本地化的字段做指定语言翻译 | `diabetes_news_translated.json` |
| `diabetes-news-report-renderer` | 汇总、清洗、去重并渲染规范 HTML 报告 | `diabetes_news_report.html` |
| `diabetes-news-report-packager` | 一步打包翻译 + 渲染流程 | `diabetes_news_report.html` |

## 配音流水线

```
源音视频
  └─ whisper-audio-to-text   → transcript.srt
      └─ subtitle-cleaner     → cleaned.srt
          └─ subtitle-fluent-translator → fluent.zh.srt
              └─ subtitle-to-speech     → dub.zh.wav
                  └─ video-zh-composer  → final.zh.mp4 (+ 硬字幕版)
```

## taskbook 结构(五件套)

每个 taskbook 目录:

```
<taskbook>/
├── contract.json     # 执行契约(outputDir/artifacts/runtimeInput/requiredTools/requiredEnv)
├── skill.md          # worker 操作指南(调哪个脚本、产物去哪)
├── spec.json         # 设计规格(goal/hardConstraints/acceptance/forbidden)
├── verify.mjs        # 机器验收脚本(只看产物事实,不评质量)
└── scripts/          # 确定性脚本(策略全在这,worker 只翻译意图)
    ├── *.mjs         # 执行脚本 / filter-lib 纯函数
    └── *.test.mjs    # 脚本纯函数单测
```

`taskbook.json`(运行历史)**不含在本仓库**,它由 UGK 运行时生成,记录每次 run 的输入和结果,含本机绝对路径,不进版本库。

## 设计原则

- **确定性归脚本,LLM 只翻译意图**:分辨率选档、字幕优先级、时间窗口映射、关键词过滤等决策全在 `scripts/` 的纯函数里,worker 只负责把用户自然语言翻译成 runtimeInput。参见各 taskbook 的 `scripts/*.test.mjs`。
- **机器验收,不评质量**:`verify.mjs` 只校验产物事实(文件存在、ffprobe 能解析、字段一致、时间窗口内),翻译/配音/搜索结果质量靠 worker LLM。
- **verify 加固**:搜索类 verify 校验 timeWindow ↔ TASK_INPUT 一致性(防 worker 偷换时间窗口)、url 域名白名单、去重、跨字段一致性(如 LinkedIn dateRange == queryUrl datePosted)。
- **反爬友好**:搜索类用单 tab 复用 + 平台切换间隔 + 人味延迟,不频繁开关 tab。

## 使用

这些 taskbook 依赖 [UGK](https://github.com/mhgd3250905/ugk-tui) 运行时。装好 UGK 后:

1. 复制到 `~/.pi/agent/tasks/`(或 `<cwd>/.tasks/`)
2. `/task run <name> <自然语言输入>`

```
# 配音流水线
/task run video-downloader 下个 https://youtu.be/xxx 1080p
/task run whisper-audio-to-text 转写 <上一步的 mp4>
/task run subtitle-cleaner 清洗 <上一步的 srt>
/task run subtitle-fluent-translator 翻译 <上一步的 srt>
/task run subtitle-to-speech 给 <上一步的 srt> 配音
/task run video-zh-composer 合成 <原mp4> + <配音wav> + <字幕srt>

# 社媒搜索(需本地登录态 Chrome)
/task run x-search 搜索 medtrum 最近一周
/task run linkedin-search 搜索 medtrum 过去一个月
/task run ins-search 搜索 medtrum 最近30天
/task run tiktok-search 搜索 medtrum 最近一周
/task run reddit-search 搜索 medtrum 最近一个月
```

## 前置依赖

**配音流水线**:
- `yt-dlp`、`ffmpeg`、`ffprobe`、`deno`(video-downloader / whisper / composer)
- Whisper `large-v3-turbo` 模型(默认 `E:\AII\.cache\whisper`,可用 `--model-dir` 覆盖)
- `MIMO_API_KEY`(subtitle-to-speech,Token Plan `tp-` 前缀)

**社媒搜索**:
- 本地 Chrome(带各平台登录态,CDP 端口默认 9222)
- 各平台账号已登录(X/LinkedIn/Instagram/TikTok/Reddit)

## 相关

- [UGK 主仓库](https://github.com/mhgd3250905/ugk-tui)
- [dispatcher eval 框架设计](https://github.com/mhgd3250905/ugk-tui/blob/codex/worktree-1/docs/design/task-extension-followup-9.md)
- [task-creator skill](https://github.com/mhgd3250905/ugk-tui/blob/codex/worktree-1/skills/task-creator/SKILL.md)(创建新 taskbook 的指南)
