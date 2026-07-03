# ugk-tasks

[UGK](https://github.com/mhgd3250905/ugk-tui) `/task` taskbook 集合。配音流水线 + 视频下载,经多轮迭代和 dispatcher eval 验证。

## 包含的 taskbook

| taskbook | 作用 | 流水线位置 |
|---|---|---|
| `video-downloader` | yt-dlp 下载公开视频,智能选分辨率/字幕 | 前置:获取源视频 |
| `whisper-audio-to-text` | Whisper large-v3-turbo 转写音视频为 SRT/VTT/TXT | 流水线第 1 步 |
| `subtitle-cleaner` | 字幕清洗(去音效标记/回声碎片/重叠,格式归一) | 流水线第 2 步 |
| `subtitle-fluent-translator` | LLM 翻译+断句重排为流畅中文字幕 | 流水线第 3 步 |
| `subtitle-to-speech` | MiMo TTS 生成按字幕时间轴的中文配音(6 路并发) | 流水线第 4 步 |
| `video-zh-composer` | 三流合成(视频+配音+字幕)为软/硬字幕 MP4 | 流水线第 5 步 |

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
├── contract.json     # 执行契约(outputDir/artifacts/runtimeInput/requiredTools/requiredBinaries)
├── skill.md          # worker 操作指南(调哪个脚本、产物去哪)
├── spec.json         # 设计规格(goal/hardConstraints/acceptance/forbidden)
├── verify.mjs        # 机器验收脚本(只看产物事实,不评质量)
└── scripts/          # 确定性脚本(策略全在这,worker 只翻译意图)
    ├── *.mjs         # 执行脚本
    └── *.test.mjs    # 脚本纯函数单测
```

`taskbook.json`(运行历史)**不含在本仓库**,它由 UGK 运行时生成,记录每次 run 的输入和结果,含本机绝对路径,不进版本库。

## 设计原则

- **确定性归脚本,LLM 只翻译意图**:分辨率选档、字幕优先级、字幕合并规则等决策全在 `scripts/` 的纯函数里,worker 只负责把用户自然语言翻译成 runtimeInput。参见各 taskbook 的 `scripts/*.test.mjs`。
- **机器验收,不评质量**:`verify.mjs` 只校验产物事实(文件存在、ffprobe 能解析、字段一致),翻译/配音质量靠 worker LLM。
- **dispatcher eval 验证翻译质量**:用 `ugk-core` 的 [dispatcher eval 框架](https://github.com/mhgd3250905/ugk-tui/blob/codex/worktree-1/scripts/eval-dispatcher.mjs) 实测,6 个 taskbook 的 dispatcher 翻译准确率 100%。

## 使用

这些 taskbook 依赖 [UGK](https://github.com/mhgd3250905/ugk-tui) 运行时。装好 UGK 后:

1. 复制到 `~/.pi/agent/tasks/`(或 `<cwd>/.tasks/`)
2. `/task run <name> <自然语言输入>`

```
# 例:整条配音流水线
/task run video-downloader 下个 https://youtu.be/xxx 1080p
/task run whisper-audio-to-text 转写 <上一步的 mp4>
/task run subtitle-cleaner 清洗 <上一步的 srt>
/task run subtitle-fluent-translator 翻译 <上一步的 srt>
/task run subtitle-to-speech 给 <上一步的 srt> 配音
/task run video-zh-composer 合成 <原mp4> + <配音wav> + <字幕srt>
```

## 前置依赖

- `yt-dlp`、`ffmpeg`、`ffprobe`、`deno`(video-downloader / whisper / composer)
- Whisper `large-v3-turbo` 模型(默认 `E:\AII\.cache\whisper`,可用 `--model-dir` 覆盖)
- `MIMO_API_KEY`(subtitle-to-speech,Token Plan `tp-` 前缀)

## 相关

- [UGK 主仓库](https://github.com/mhgd3250905/ugk-tui)
- [dispatcher eval 框架设计](https://github.com/mhgd3250905/ugk-tui/blob/codex/worktree-1/docs/design/task-extension-followup-9.md)
