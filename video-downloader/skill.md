# 通用视频下载

给定一个公开视频 URL,用 yt-dlp 下载视频为 MP4,按用户意图自动选择分辨率与字幕,并在存在可用字幕时下载字幕文件。

## 输入

- `url`: 视频页面链接,必填,支持 yt-dlp 能解析的 `http`/`https` URL。
- `maxHeight`: 可选。用户指定的视频高度上限(像素)。指定时下载 `<=` 该高度的最大规格;**不指定时脚本自动选**(按固定档位链 1080→720→480→360→240→144 取第一个可用)。用户明确说了 1080p/720p/高清等才填;没提分辨率就**省略**。
- `subLangs`: 可选。字幕语言(如 `en`、`zh`、`ru`,逗号分隔)。指定时严格下载指定语种;**不指定时脚本自动选**(优先人工字幕全部语种,无人工才回退自动字幕 `en`+`zh`,都无则不下)。用户明确说要某种语言字幕才填;没提就**省略**。
- `cookiesFromBrowser`: 可选,只允许 `none` 或 `chrome`,默认 `none`。用户说用 Chrome 登录态、Chrome cookies、已登录浏览器下载时填 `chrome`。

## 步骤

1. 从 runtime input 读取 `url`、`cookiesFromBrowser`,以及**可选的** `maxHeight`、`subLangs`(未指定就别传,让脚本自动选)。
2. 运行 taskbook 自带脚本:

```bash
node "$TASK_DIR/scripts/download-video.mjs" \
  --url "<url>" \
  --output-dir "<outputDir>" \
  --cookies-from-browser "<cookiesFromBrowser>"
```

`<outputDir>` 必须用本次 task prompt 给出的产出目录。

`--max-height` 和 `--sub-langs` 只在用户明确指定时才加(用户没说分辨率/字幕就别加,脚本会自动选):

```bash
# 仅当用户明确要某分辨率时
  --max-height "<maxHeight>" \
# 仅当用户明确要某语言字幕时
  --sub-langs "<subLangs>" \
```

## 智能选择(脚本自动处理,worker 不要手动决定)

分辨率和字幕的选择由 taskbook 脚本依据实际 metadata 做出,worker 只负责把"用户有没有指定"如实传达(指定就传参,没指定就省略):

- **分辨率**:`maxHeight` 传了 → 选 `<=` 该高度最大规格;没传 → 档位链 `1080→720→480→360→240→144` 取首个可用。采用**区间匹配**:高度落在某档位的 `(下一档, 本档]` 区间即算命中该档(如 1058 归入 1080 档,706 归入 720 档),非标准高度也能正确识别;全部超档(如 4K)则取可用最大。竖屏视频按短边(width)判断。
- **字幕**:`subLangs` 传了 → 严格用指定语种(含自动字幕);没传 → **四级优先**:① 人工字幕(`metadata.subtitles`)全部语种(量可控);② 视频主语言(`metadata.language`,如 `ru`/`en-US`)的自动字幕(最贴合原声);③ 自动字幕 `en`+`zh`;④ 都无则不下(不算失败)。例:俄语视频无人工字幕 → 自动下 `ru`+`ru-orig` 字幕。

决策依据会写进 `download-summary.json` 的 `resolutionSelection` / `subtitleSelection`,便于验收和诊断。

## 产出

- `metadata.json`: yt-dlp 元数据。
- `download-summary.json`: 下载摘要,含 extractor、`resolutionSelection`、`subtitleSelection`、视频文件和字幕文件列表。
- `<extractor>-<id>.mp4`: 下载并合并后的视频。
- `<extractor>-<id>.<lang>.vtt`: 字幕文件,仅在站点提供可用字幕且脚本决定下载时出现。

## 注意

- **运行依赖**:本 task 需要 `yt-dlp`、`ffmpeg`、`ffprobe`、`deno` 四个外部命令在 PATH 里。`deno` 是 yt-dlp 新版下 YouTube 自动字幕必需的 JS 运行时,缺失会导致字幕下载失败(报 "No supported JavaScript runtime")。框架会在运行前自动检查这些(prequiredBinaries),缺哪个装哪个。
- 字幕是有则下载(按上面的智能选择规则),没有可用字幕不算失败。
- 这是单视频下载器,默认 `--no-playlist`;不要下载整个播放列表。
- 不要临时改写下载流程,也不要自行决定分辨率档位或字幕语种;脚本已经处理 URL 校验、metadata 探测、分辨率/字幕智能选择、元数据和摘要。
- 如果遇到 YouTube 429、visitor_data 或 cookies 相关错误,只能改 `cookiesFromBrowser` 后重新运行本脚本;不要直接调用 `yt-dlp`、不要手写 cookies 文件、不要绕过 taskbook 脚本。
- 不要把视频或字幕内容贴进回复,只回复产物路径和简短统计。
