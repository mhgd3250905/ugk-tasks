# 字幕转中文配音

给定一个中文字幕文件,用 MiMo TTS 生成按字幕时间轴铺好的中文配音音频。

## 输入

- `subtitlePath`: 中文字幕路径,必填,支持 `.srt`/`.vtt`。
- `voice`: 可选 MiMo 预置音色 ID,默认 `冰糖`。必须填精确 ID,不能填自然语言描述。
- `stylePrompt`: 可选 MiMo 风格提示。
- `maxChars`: 可选,仅用于输入校验兼容;TTS 必须逐字幕 cue 生成,不得跨 cue 合并。

## MiMo 预置音色

| ID | 语言 | 性别 | 适用 |
|---|---|---|---|
| `mimo_default` | 依集群而定 | - | 默认音色 |
| `冰糖` | 中文 | 女 | 默认中文女声 |
| `茉莉` | 中文 | 女 | 中文女声 |
| `苏打` | 中文 | 男 | 偏年轻、有活力的中文男声 |
| `白桦` | 中文 | 男 | 偏沉稳的中文男声 |
| `Mia` | 英文 | 女 | 英文女声 |
| `Chloe` | 英文 | 女 | 英文女声 |
| `Milo` | 英文 | 男 | 英文男声 |
| `Dean` | 英文 | 男 | 英文男声 |

dispatcher 根据用户想要的语言、性别和气质选择最接近的预置音色 ID;语气、节奏、感染力等表达方式放进 `stylePrompt`。

### voice vs stylePrompt 分工(v2.5 风格指令遵循)

MiMo v2.5 具备强风格指令理解与遵循能力,情绪/语气/语速/气质全部由 `stylePrompt` 控制。分工原则:

- **voice** = 音色 ID(谁在说话),9 选 1,只看语言+性别选最接近的。
- **stylePrompt** = 情绪/语气/语速/气质(怎么说),自由文本,v2.5 会遵循。

用户描述声音气质时,dispatcher 不要试图把这些映射到 voice ID,而是把描述写进 stylePrompt。示例:

| 用户表述 | voice | stylePrompt |
|---|---|---|
| "沉稳解说" | 白桦(中文男声) | 沉稳、缓慢、有厚度 |
| "活泼少女" | 冰糖(中文女声) | 轻快、上扬、有笑意 |
| "性感一点" | 冰糖(默认女声) | 性感、低沉、慵懒 |
| "像新闻联播主播" | 白桦(沉稳男声) | 字正腔圆、端庄、播报感、语速适中 |

即使用户的描述(如"像新闻联播主播")没有完全对应的预置音色,也要把描述忠实写进 stylePrompt,让 v2.5 去遵循——不要因为"没有这个音色"就放弃或瞎猜 voice。

## 步骤

1. 从 runtime input 读取字段,不要把 `MIMO_API_KEY` 当作输入字段,不要在日志/产物/回复里打印 API key 的完整值。脚本会根据 key 前缀(sk-/tp-)路由 endpoint,这是功能必需的前缀判断,不算泄露(前缀本身不是秘密,完整 key 永不输出)。
2. 确保 `$TASK_OUTPUT_DIR` 存在。
3. 先运行 preflight。失败就立刻停止并把错误原样报告给用户:

```bash
node "$TASK_DIR/scripts/subtitle-to-speech.mjs" \
  --preflight \
  --subtitle "<subtitlePath>" \
  --output-dir "$TASK_OUTPUT_DIR"
```

`<subtitlePath>` 和 `<outputDir>` 通过 CLI 传入(路径字符串,安全)。其余字段(voice/stylePrompt/maxChars)脚本会自动从环境变量 `TASK_INPUT` 读取——**不要**把它们拼进命令行。原因:stylePrompt 是用户自由文本,可能含双引号、`$`、反引号等特殊字符,拼进 bash 命令会破坏解析或触发注入;走环境变量则完全安全。

4. 运行生成脚本:

```bash
node "$TASK_DIR/scripts/subtitle-to-speech.mjs" \
  --subtitle "<subtitlePath>" \
  --output-dir "$TASK_OUTPUT_DIR"
```

和 preflight 一样,其余字段自动从 `TASK_INPUT` 读取,不要拼进命令行。
脚本会输出 `[tts] i/n xx% ...` 进度,不要隐藏它。

## 产出

- `source.cues.json`: 程序解析出的字幕结构。
- `dub.zh.wav`: 中文配音音轨。
- `tts-summary.json`: 运行摘要。
- `audio-concat.txt`: ffmpeg concat 列表。
- `tts-segments/`: MiMo TTS 分段缓存。

## 注意

- 运行时必须有 `MIMO_API_KEY`;缺失时应直接报错,不要继续。
- `voice` 不在预置音色列表内时必须停止,不要 fallback 到默认音色。
- MiMo TTS 会消耗接口配额或产生费用。
- 这个 task 只做配音音频,不下载视频、不翻译字幕、不合成视频。
- **输入质量门禁**:脚本会检查输入字幕质量。明显低质量的脏字幕(YouTube 未清洗的滚动回声碎片过多、全是音效标记无对白)会被直接打回,报错信息只描述"需要什么质量的字幕"(不指定用什么工具清洗)。避免把脏字幕合成成垃圾配音。
- 不要把字幕全文、API key 放进最终回复;只回复产物路径和简短统计。
