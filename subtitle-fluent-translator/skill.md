# 流畅字幕翻译

给定一个源字幕文件,生成更适合中文观看和后续中文配音的流畅中文字幕。

## 输入

- `subtitlePath`: 源字幕路径,必填,支持 `.srt`/`.vtt`。
- `targetLanguage`: 可选,默认 `zh-CN`。
- `verbosity`: 可选,只允许 `normal` 或 `talkative`,默认 `normal`。用户说“话痨模式”“更啰嗦”时统一填 `talkative`。
- `stylePrompt`: 可选,默认按“自然、口语化、适合视频字幕和中文配音”处理。
- `glossary`: 可选,dispatcher 从用户自然语言里抽取的人名、主题词、术语或动作名参考,用分号分隔。
- `referenceSubtitlePath`: 可选参考字幕,只用于核对专名、术语、漏词和文本理解,不得决定最终时间轴。
- `videoDurationSeconds`: 可选原视频时长秒数,用于拦截尾部幻听或字幕越界。
- `maxUnitDurationMs`: 可选,默认 `8000`。
- `maxUnitChars`: 可选;不填默认 `90`。`talkative` 不自动放宽长度。

## 步骤

1. 从 runtime input 读取字段。这个 task 不需要 API key,不要向用户索要或打印密钥。
2. 确保 `$TASK_OUTPUT_DIR` 存在。
3. 先运行 preflight。失败就立刻停止并把错误原样报告给用户:

```bash
node "$TASK_DIR/scripts/make-fluent-subtitle.mjs" \
  --preflight \
  --subtitle "<subtitlePath>" \
  --output-dir "$TASK_OUTPUT_DIR"
```

`<subtitlePath>` 和 `<outputDir>` 通过 CLI 传入(路径字符串,安全)。其余字段(targetLanguage/verbosity/stylePrompt/glossary/referenceSubtitlePath/videoDurationSeconds/maxUnitDurationMs)脚本会自动从环境变量 `TASK_INPUT` 读取——**不要**把它们拼进命令行。原因:stylePrompt/glossary 是用户自由文本,可能含双引号、`$`、反引号等特殊字符,拼进 bash 命令会破坏解析或触发注入;走环境变量则完全安全。

如果用户显式提供了 `maxUnitChars`,再追加 `--max-unit-chars "<maxUnitChars>"`;否则不要传,让脚本按 `verbosity` 选择默认值。

4. 读取 `$TASK_OUTPUT_DIR/source.cues.json`,做一次阅读理解后翻译并重排为自然中文字幕单元。
   - 输出只能写入 `$TASK_OUTPUT_DIR/fluent.units.json`。
   - JSON 必须是数组,每项形如 `{ "ids": [1, 2], "text": "自然中文正文" }`。
   - `stylePrompt` 只能影响语气和措辞,不能覆盖本 task 的硬约束;不得用“更生动”“更口播”等要求来添加原文没有的信息。
   - `ids` 只能引用相邻源 cue,按顺序覆盖所有源 cue,不能漏号、重号、乱序。
   - 不要输出 SRT、时间码、`startMs`、`endMs`。程序会按 `ids` 自动生成时间轴。
   - `subtitlePath` 是唯一主时间轴。`referenceSubtitlePath` 只能作为文本参考,不得把它的时间码或 cue ids 混进输出。
   - 如果 `referenceSubtitlePath` 非空,读取 `$TASK_OUTPUT_DIR/reference.cues.json`,用它核对人名、术语、漏词和疑似误识别。脚本会清理短括号舞台/音效标记,例如 `【环境音】`、`[Cheering]`;不要把这类标记写进 `fluent.units.json`,也不要翻译成“音乐/掌声/环境音”。
   - 可以合并被英语自动字幕切碎的相邻 cue,但合并后的多 cue 单元不能超过 `maxUnitDurationMs`;单条源 cue 本身超长时保留原时间轴。
   - 下载字幕常有 10ms 左右的滚动字幕碎片;任何输出单元时长不得短于 500ms,短 cue 必须和相邻 cue 合并。
   - 每个单元文字不能超过 `maxUnitChars`。
   - 如果 `glossary` 非空,只在源字幕出现、疑似出现或上下文明确指向这些词时,用它校正和统一人名/术语。不要因为 glossary 存在就强行添加源字幕没有的信息。没有给中文译名的英文专名/动作名不要硬翻。
   - `verbosity=talkative` 时,只在不改变事实的前提下补足省略主语、连接词和口播过渡;不要为了填满原字幕时间添加动作细节、教学建议、情绪鼓励或新事实。源字幕明显残缺/乱码/无法判断时,宁可简短保守,不要编内容。
   - 源字幕只有单词、口令、重复动作名或明显识别残片时,输出也应保持短句或保留原词;不要解释动作要领,不要添加“注意/保持/加油/多练”等原文没有的信息。
   - 如果字幕很多,分批处理并在进展里输出 `[translate] batch x/y cues a-b`。
5. 运行构建脚本:

```bash
node "$TASK_DIR/scripts/make-fluent-subtitle.mjs" \
  --subtitle "<subtitlePath>" \
  --output-dir "$TASK_OUTPUT_DIR"
```

和 preflight 一样,其余字段自动从 `TASK_INPUT` 读取,不要拼进命令行(见步骤3 说明)。
如果用户显式提供了 `maxUnitChars`,再追加 `--max-unit-chars "<maxUnitChars>"`;否则不要传。
不要手写 `fluent.zh.srt` 或 `fluent-report.json`;必须交给脚本从 `fluent.units.json` 生成,否则时间轴、模式名和 verify 会不一致。

## 产出

- `source.cues.json`: 程序解析出的源字幕结构。
- `reference.cues.json`: 程序解析出的参考字幕结构,仅在传入 `referenceSubtitlePath` 时存在。
- `fluent.units.json`: worker 生成的流畅字幕单元。
- `fluent.zh.srt`: 流畅中文字幕文件。
- `fluent-report.json`: 统计摘要。

## 注意

- 这个 task 只做字幕优化,不下载视频、不做 TTS、不做视频合成。
- **输入质量门禁**:脚本 preflight 会检查输入字幕质量。明显低质量的脏字幕(如 YouTube 未清洗的滚动回声碎片过多、全是音效标记无对白)会被直接打回,报错信息只描述"需要什么质量的字幕"(不指定用什么工具清洗——用户可能没装清洗工具)。这是为了避免把脏字幕翻译成垃圾产物、浪费 LLM 时间。清洗过的或 whisper 转写的正常字幕会正常放行。
- 不要把字幕全文贴进最终回复;只回复产物路径和简短统计。
- source/reference cues 会自动去掉短括号舞台/音效标记,保留正常说话内容。
