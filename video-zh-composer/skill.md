# 中文配音视频合成

给定视频、中文配音音频和中文字幕,产出软字幕版与硬字幕版 MP4。

## 输入

- `videoPath`: 本地视频路径,必填。
- `audioPath`: 中文配音音频路径,必填,通常来自 `subtitle-to-speech` 的 `dub.zh.wav`。
- `subtitlePath`: 中文字幕路径,必填,支持 `.srt`/`.vtt`。
- `subtitleColor`: 可选硬字幕文字颜色,只允许 `white`、`yellow`、`pink`,默认 `white`。用户说白色/黄色/粉色时分别填 `white`/`yellow`/`pink`。

## 步骤

1. 从 runtime input 读取字段。这个 task 不需要 API key,不要向用户索要或打印密钥。
2. 确保 `$TASK_OUTPUT_DIR` 存在。
3. 先运行 preflight。失败就立刻停止并把错误原样报告给用户:

```bash
node "$TASK_DIR/scripts/compose-video-zh.mjs" \
  --preflight \
  --video "<videoPath>" \
  --audio "<audioPath>" \
  --subtitle "<subtitlePath>" \
  --output-dir "$TASK_OUTPUT_DIR" \
  --subtitle-color "<subtitleColor>"
```

4. 运行合成脚本:

```bash
node "$TASK_DIR/scripts/compose-video-zh.mjs" \
  --video "<videoPath>" \
  --audio "<audioPath>" \
  --subtitle "<subtitlePath>" \
  --output-dir "$TASK_OUTPUT_DIR" \
  --subtitle-color "<subtitleColor>"
```

## 产出

- `subtitle.zh.srt` 或 `subtitle.zh.vtt`: 复制到 outputDir 的中文字幕。
- `subtitle.zh.hardsub.ass`: 用于硬字幕烧录的 ASS 字幕(PlayRes=视频尺寸,字号自适应横竖屏)。
- `final.zh.mp4`: 中文配音 + 可开关中文字幕软字幕。
- `final.zh.hardsub.mp4`: 中文配音 + 指定颜色的烧录中文字幕。
- `compose-summary.json`: 运行摘要。

## 注意

- 这个 task 只做合成,不下载视频、不翻译字幕、不做 TTS。
- 若中文配音短于视频,合成时保留完整视频时长,音频尾部补静音,不要截掉视频结尾。
- 硬字幕用 ASS 格式(带 PlayResX/PlayResY=视频实际尺寸 + 字号按视频高度动态算),横屏竖屏都自适应不超宽;不加背景条,长字幕按标点换行 + 拆 cue。
- 不要把字幕全文、视频内容放进最终回复;只回复产物路径和简短统计。
