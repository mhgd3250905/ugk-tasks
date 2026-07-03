# 字幕清洗

给定一个脏字幕文件(任意格式),产出一个格式归一、无重叠、无回声碎片、无音效标记的标准 SRT。

## 这个 task 做什么 / 不做什么

**做(纯结构性清洗,不碰文本语义)**:
1. 格式归一:TTML / VTT / SRT → 统一输出 SRT
2. 去重:删除 YouTube 滚动回声碎片(10ms 短 cue 重复相邻长 cue 文本的副本)
3. 重排:把相邻 cue 的重叠时间改成首尾相接(`endMs = min(本句end, 下句begin)`)
4. 去音效标记:`[Music]`/`[Applause]`/`【环境音】` 等短括号标记

**不做**:
- ❌ 翻译、合并句子成意群、改写文本(本 task 只做结构性清洗,不碰语义)
- ❌ 下载视频/字幕
- ❌ 任何其他 task 的工作(task 各自独立,如何编排由调用方决定)

## 输入

- `subtitlePath`: 源字幕本地路径,必填。支持 TTML/VTT/SRT,脚本自动识别格式。

## 步骤

1. 从 runtime input 读取 `subtitlePath`。这个 task 不需要 API key。
2. 确保 `$TASK_OUTPUT_DIR` 存在。
3. 运行清洗脚本:

```bash
node "$TASK_DIR/scripts/clean-subtitle.mjs" \
  --subtitle "<subtitlePath>" \
  --output-dir "$TASK_OUTPUT_DIR"
```

脚本会自动:识别格式 → 解析 → 去回声碎片 → 重排重叠 → 去音效标记 → 输出 `cleaned.srt` + `clean-report.json`。

## 产出

- `cleaned.srt`: 清洗后的标准 SRT(无重叠、无碎片、无音效标记)。
- `clean-report.json`: 清洗统计(源格式、cue 数、重叠数、短 cue 数、起止时间)。

## 注意

- 坏时间码(零时长/倒置 cue)会直接报错停止,不静默丢文本。源字幕有问题时,修好源字幕再重跑。
- 不要把字幕全文贴进最终回复;只回复产物路径和简短统计。
- 不要手写 cleaned.srt;必须交给脚本生成,否则格式和 verify 会不一致。
