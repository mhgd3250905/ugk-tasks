# Whisper Turbo 音视频转写

接收本地音视频文件路径,使用本机 OpenAI Whisper CLI 的 `large-v3-turbo` 模型转写,产出 TXT/SRT/VTT/JSON。

## 输入

- `file_path`: 本地音视频文件绝对路径,必填。脚本也兼容 `filePath`。
- `language`: 可选,例如 `ru`、`en`、`ja`、`zh`;不填则 Whisper 自动识别。
- `task`: 可选,`transcribe` 或 `translate`,默认 `transcribe`。中文配音/字幕优化链路必须用 `transcribe`;`translate` 是 Whisper 翻成英文,只在用户明确要英文翻译字幕时使用。
- `model`: 可选,默认 `large-v3-turbo`。

## 步骤

1. 从 runtime input 读取字段。这个 task 不需要 API key,不需要 MCP。
2. 确保 `$TASK_OUTPUT_DIR` 存在。
3. 运行 taskbook 自带脚本:

```bash
node "$TASK_DIR/scripts/whisper-audio-to-text.mjs" \
  --file-path "<file_path>" \
  --output-dir "$TASK_OUTPUT_DIR" \
  --language "<language>" \
  --task "<task>" \
  --model "<model>"
```

如果用户没有提供 `language`,不要传 `--language`;让 Whisper 自动识别。默认模型目录固定为 `E:\AII\.cache\whisper`,不要把模型下载到 C 盘。

不要绕过脚本直接调用 `whisper` 或 `whisper --help`;脚本会给 Whisper 子进程设置 UTF-8 环境变量,并清理短括号舞台/音效标记（如 `【环境音】`、`[Cheering]`）。

## 产出

- `transcript.txt`: 纯文本转写。
- `transcript.srt`: SRT 字幕。
- `transcript.vtt`: VTT 字幕。
- `transcription.json`: Whisper JSON 原始结果。
- `transcript.tsv`: Whisper TSV 结果。
- `whisper-summary.json`: 运行摘要。
- `extracted_audio.wav`: 仅当输入是视频时生成。

## 注意

- 这个 task 取代 FunASR 用于小语种转写;旧 `audio-to-text` 不在这里调用。
- 不要把转写全文贴进最终回复;只回复产物路径和简短统计。
- 长视频会耗时,脚本会透传 Whisper 输出。
- 输出 TXT/SRT/VTT/TSV/JSON 会去掉短括号舞台/音效标记,保留正常说话内容。
