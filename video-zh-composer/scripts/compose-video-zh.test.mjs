import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	audioVideoDurationStatus,
	buildAssFile,
	buildFinalMuxArgs,
	buildHardsubArgs,
	fontSizeForVideo,
	needsTranscode,
	parseAndWrapCues,
	parseCliArgs,
	resolveAssFont,
	subtitleWrapChars,
	wrapSubtitleFile,
	wrapSubtitleText,
} from "./compose-video-zh.mjs";

function hasCommand(command) {
	try {
		execFileSync(command, ["-version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function mediaDuration(filePath) {
	return Number(execFileSync("ffprobe", [
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		filePath,
	], { encoding: "utf8" }).trim());
}

test("parses cli args", () => {
	assert.deepEqual(parseCliArgs([
		"--preflight",
		"--video", "video.mp4",
		"--audio", "dub.wav",
		"--subtitle", "zh.srt",
		"--output-dir", "out",
		"--subtitle-color", "pink",
	]), {
		preflight: true,
		videoPath: "video.mp4",
		audioPath: "dub.wav",
		subtitlePath: "zh.srt",
		outputDir: "out",
		subtitleColor: "pink",
	});
});

test("final mux uses video, dub audio, and soft subtitles", () => {
	const args = buildFinalMuxArgs({
		videoPath: "input.mp4",
		audioPath: "dub.zh.wav",
		subtitlePath: "subtitle.zh.srt",
		outputPath: "final.zh.mp4",
		durationSeconds: 169.141,
		copyVideo: true,
	});

	assert.ok(args.includes("-map"));
	assert.ok(args.includes("0:v:0"));
	assert.ok(args.includes("1:a:0"));
	assert.ok(args.includes("2:0"));
	assert.ok(args.includes("mov_text"));
	assert.ok(args.includes("-af"));
	assert.ok(args.includes("apad"));
	assert.ok(args.includes("-t"));
	assert.ok(args.includes("169.141"));
	assert.equal(args.includes("-shortest"), false);
	assert.ok(args.includes("final.zh.mp4"));
});

test("hardsub render burns subtitles via ASS(竖屏修复后:无force_style,无黑底条)", () => {
	// ponytail 竖屏修复:硬字幕改 ASS,烧录参数简化。颜色/字号在 ASS 文件里,不在 CLI。
	const args = buildHardsubArgs({
		inputPath: "final.zh.mp4",
		subtitlePath: "subtitle.zh.hardsub.ass",
		outputPath: "final.zh.hardsub.mp4",
	});

	assert.ok(args.includes("-vf"));
	// 无黑底条(drawbox)
	assert.equal(args.some((arg) => arg.includes("drawbox=")), false);
	// 烧录 ASS 文件
	assert.ok(args.some((arg) => arg.includes("subtitles=subtitle.zh.hardsub.ass")));
	// ASS 自带样式,不用 force_style
	assert.equal(args.some((arg) => arg.includes("force_style")), false);
	assert.ok(args.includes("-c:a"));
	assert.ok(args.includes("copy"));
	assert.ok(args.includes("final.zh.hardsub.mp4"));
});

test("wraps long subtitle text to fit the video width", () => {
	const wrapped = wrapSubtitleText("我先简单讲讲这是什么。当我们开始编排动作的时候，从零开始其实是非常困难的。", 12);
	const lines = wrapped.split("\n");

	assert.ok(lines.length > 1);
	assert.ok(lines.every((line) => Array.from(line).length <= 13));
	assert.equal(lines.some((line) => /^[，。！？；：、]/u.test(line)), false);
	// ponytail 竖屏修复:subtitleWrapChars 新签名 (width, fontSize),基于字号算字数。
	// 横屏竖屏都不超宽。fontSize 按视频高度算(fontSizeForVideo)。
	assert.equal(subtitleWrapChars(1920, fontSizeForVideo(1080)), Math.floor(1920 / fontSizeForVideo(1080) * 0.95));
	assert.equal(subtitleWrapChars(1280, fontSizeForVideo(720)), Math.floor(1280 / fontSizeForVideo(720) * 0.95));
});

test("fontSizeForVideo: 字号按视频高度动态算(横竖屏自适应)", () => {
	// ponytail 竖屏修复:不固定16,按高度约4.5%
	assert.equal(fontSizeForVideo(1080), 49); // 横屏
	assert.equal(fontSizeForVideo(854), 38);  // 竖屏
	assert.equal(fontSizeForVideo(720), 32);
	assert.equal(fontSizeForVideo(480), 22);
});

test("竖屏字幕换行字数少于横屏(都不超宽)", () => {
	// 竖屏480×854 vs 横屏1920×1080,字号自适应后每行字数都合理
	const vertChars = subtitleWrapChars(480, fontSizeForVideo(854));
	const horizChars = subtitleWrapChars(1920, fontSizeForVideo(1080));
	// 竖屏字数 < 横屏(竖屏窄)
	assert.ok(vertChars < horizChars, `竖屏${vertChars}应<横屏${horizChars}`);
	// 竖屏一行总宽 = 字数×字号 ≤ 视频宽(不超宽的核心验证)
	assert.ok(vertChars * fontSizeForVideo(854) <= 480, `竖屏一行${vertChars}×${fontSizeForVideo(854)}应≤480`);
	assert.ok(horizChars * fontSizeForVideo(1080) <= 1920, `横屏一行${horizChars}×${fontSizeForVideo(1080)}应≤1920`);
});

test("prefers punctuation boundaries when wrapping subtitle text", () => {
	const wrapped = wrapSubtitleText("这就是我们编排动作的方式。今天这节课，我就会把这些定位点教给你。", 20);

	assert.ok(wrapped.includes("方式。\n今天"));
	assert.equal(wrapped.includes("今\n天"), false);
});

test("does not split latin words while wrapping subtitle text", () => {
	const wrapped = wrapSubtitleText("一般做两三个穿插就够了，然后接上 baby freeze。", 14);

	assert.equal(wrapped.includes("free\nze"), false);
	assert.equal(wrapped.includes("\n。"), false);
});

test("splits very long hard subtitles into cues with at most two lines", () => {
	const wrapped = wrapSubtitleFile(`1
00:00:00,000 --> 00:00:08,000
这就是我们编排动作的方式。今天这节课，我就会把这些定位点教给你。回去之后你自己练习这些定位点，然后把视频发给我。
`, 20);
	const blocks = wrapped.trim().split(/\n{2,}/);

	assert.ok(blocks.length > 1);
	assert.ok(wrapped.includes("定位点"));
	assert.ok(wrapped.includes("发给我。"));
	for (const block of blocks) {
		const lines = block.split("\n");
		const timingIndex = lines.findIndex((line) => line.includes("-->"));
		assert.ok(lines.slice(timingIndex + 1).length <= 2);
	}
});

test("rejects unsupported subtitle colors", () => {
	assert.throws(() => parseCliArgs(["--subtitle-color", "green"]), /subtitleColor must be white, yellow, or pink/);
});

test("cli preserves video duration when dubbed audio is shorter", { timeout: 30000 }, () => {
	if (!hasCommand("ffmpeg") || !hasCommand("ffprobe")) return;
	const workDir = mkdtempSync(path.join(tmpdir(), "video-zh-composer-"));
	const videoPath = path.join(workDir, "input.mp4");
	const audioPath = path.join(workDir, "dub.wav");
	const subtitlePath = path.join(workDir, "subtitle.srt");
	const outputDir = path.join(workDir, "out");
	const scriptPath = fileURLToPath(new URL("./compose-video-zh.mjs", import.meta.url));

	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=duration=2.4:size=320x180:rate=25",
		"-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
		"-t", "2.4",
		"-c:v", "libx264",
		"-pix_fmt", "yuv420p",
		"-c:a", "aac",
		videoPath,
	]);
	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
		"-t", "1.0",
		"-c:a", "pcm_s16le",
		audioPath,
	]);
	writeFileSync(subtitlePath, "1\n00:00:00,000 --> 00:00:01,000\n测试字幕\n", "utf8");

	execFileSync(process.execPath, [
		scriptPath,
		"--video", videoPath,
		"--audio", audioPath,
		"--subtitle", subtitlePath,
		"--output-dir", outputDir,
	], { encoding: "utf8" });

	assert.ok(mediaDuration(path.join(outputDir, "final.zh.mp4")) >= 2.2);
	assert.ok(mediaDuration(path.join(outputDir, "final.zh.hardsub.mp4")) >= 2.2);
});

// ============================================================
// 竖屏修复:ASS 生成 + parseAndWrapCues
// ============================================================
test("parseAndWrapCues: 解析字幕返回结构化 cue 数组(含换行)", () => {
	const srt = "1\n00:00:01,000 --> 00:00:03,000\n这是第一句测试字幕\n\n2\n00:00:04,000 --> 00:00:06,000\n第二句";
	const cues = parseAndWrapCues(srt, 20);
	assert.ok(Array.isArray(cues));
	assert.ok(cues.length >= 2);
	assert.equal(cues[0].startMs, 1000);
	assert.equal(cues[0].endMs, 3000);
	assert.equal(cues[1].text, "第二句");
});

test("parseAndWrapCues: 长字幕拆成多 cue(按时长比例分)", () => {
	const srt = "1\n00:00:00,000 --> 00:00:10,000\n这是一段很长的字幕需要被拆分成多个短句才能适配屏幕显示宽度测试";
	const cues = parseAndWrapCues(srt, 10);
	assert.ok(cues.length > 1, "长字幕应拆成多 cue");
	// 末 cue 的 endMs 应等于原 endMs
	assert.equal(cues[cues.length - 1].endMs, 10000);
});

test("buildAssFile: 生成合法 ASS 结构(三段齐全)", () => {
	const cues = [{ startMs: 1000, endMs: 3000, text: "第一行\n第二行" }];
	const ass = buildAssFile(cues, { videoWidth: 480, videoHeight: 854, subtitleColor: "white" });
	assert.ok(ass.includes("[Script Info]"));
	assert.ok(ass.includes("[V4+ Styles]"));
	assert.ok(ass.includes("[Events]"));
	assert.ok(ass.includes("ScriptType: v4.00+"));
});

test("buildAssFile: PlayResX/PlayResY = 视频实际尺寸(字号1:1的关键)", () => {
	const cues = [{ startMs: 0, endMs: 1000, text: "测" }];
	const ass = buildAssFile(cues, { videoWidth: 480, videoHeight: 854 });
	assert.ok(ass.includes("PlayResX: 480"));
	assert.ok(ass.includes("PlayResY: 854"));
});

test("buildAssFile: 字号按视频高度动态算(不固定16)", () => {
	const cues = [{ startMs: 0, endMs: 1000, text: "测" }];
	const assTall = buildAssFile(cues, { videoHeight: 1080 });
	const fsTall = fontSizeForVideo(1080);
	// Style 行是值序列: ...,Fontname,Fontsize,PrimaryColour,... 故断言 ",<fs>,&H" 模式
	assert.ok(assTall.includes(`,${fsTall},&H`), `Style行应含字号 ${fsTall}`);
	const assVert = buildAssFile(cues, { videoHeight: 854 });
	assert.ok(assVert.includes(`,${fontSizeForVideo(854)},&H`), "竖屏字号应不同于横屏");
});

test("buildAssFile: 时间用百分秒格式(H:MM:SS.cc)", () => {
	const cues = [{ startMs: 65400, endMs: 70000, text: "测" }]; // 1:05.4 - 1:10.0
	const ass = buildAssFile(cues, {});
	assert.ok(ass.includes("0:01:05."), "start 应是百分秒格式");
	assert.ok(ass.includes("0:01:10."), "end 应是百分秒格式");
});

test("buildAssFile: 文本内换行转 \\N(ASS硬换行)", () => {
	const cues = [{ startMs: 0, endMs: 1000, text: "第一行\n第二行" }];
	const ass = buildAssFile(cues, {});
	assert.ok(ass.includes("第一行\\N第二行"), "换行应转 \\N");
	assert.ok(!ass.includes("第一行\n第二行"), "不应有原始换行(会被ASS解析错)");
});

test("buildAssFile: 颜色从常量取(白色/黄色/粉色)", () => {
	const cues = [{ startMs: 0, endMs: 1000, text: "测" }];
	const white = buildAssFile(cues, { subtitleColor: "white" });
	assert.ok(white.includes("&H00FFFFFF&"), "应含白色ASS编码");
	const yellow = buildAssFile(cues, { subtitleColor: "yellow" });
	assert.ok(yellow.includes("&H0000FFFF&"), "应含黄色ASS编码");
});

test("buildHardsubArgs: 烧录ASS不用force_style(ASS自带样式)", () => {
	const args = buildHardsubArgs({ inputPath: "in.mp4", subtitlePath: "sub.ass", outputPath: "out.mp4" });
	const vf = args.find((a) => typeof a === "string" && a.startsWith("subtitles="));
	assert.ok(vf);
	assert.ok(!vf.includes("force_style"), "烧ASS不应有force_style");
});

// === 缺陷2:VP9/AV1 预判转码 ===
// ponytail: VP9/VP8 进 MP4 容器被 ffmpeg 拒绝。preflight 读 codec 预判,省一轮 copy 失败。

test("needsTranscode: VP9/VP8/theora 需转码,h264/hevc/av1 可 copy", () => {
	assert.equal(needsTranscode("vp9"), true);
	assert.equal(needsTranscode("VP9"), true); // 大小写归一
	assert.equal(needsTranscode("vp8"), true);
	assert.equal(needsTranscode("theora"), true);
	assert.equal(needsTranscode("h264"), false);
	assert.equal(needsTranscode("hevc"), false);
	assert.equal(needsTranscode("av1"), false); // 新 ffmpeg 支持_av1 进 mp4
	assert.equal(needsTranscode(""), false); // 未知编码保守 copy(让 ffmpeg 自己判)
});

// === 缺陷3:中文字体检测(防豆腐块假通过)===

test("resolveAssFont: Windows 有 msyh.ttc 返回 Microsoft YaHei", () => {
	const font = resolveAssFont({
		platform: "win32",
		fontsDir: "C:\\Windows\\Fonts",
		checkExists: (p) => p.endsWith("msyh.ttc"),
	});
	assert.equal(font, "Microsoft YaHei");
});

test("resolveAssFont: Windows 无 msyh 但有 simhei 返回 SimHei", () => {
	const font = resolveAssFont({
		platform: "win32",
		fontsDir: "C:\\Windows\\Fonts",
		checkExists: (p) => p.endsWith("simhei.ttf"),
	});
	assert.equal(font, "SimHei");
});

test("resolveAssFont: macOS 有 PingFang SC 返回它", () => {
	const font = resolveAssFont({
		platform: "darwin",
		fcList: () => "/System/Library/Fonts/PingFang.ttc: PingFang SC,苹方",
	});
	assert.equal(font, "PingFang SC");
});

test("resolveAssFont: Linux 有 Noto Sans CJK SC 返回它", () => {
	const font = resolveAssFont({
		platform: "linux",
		fcList: () => "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc: Noto Sans CJK SC",
	});
	assert.equal(font, "Noto Sans CJK SC");
});

test("resolveAssFont: 检测不到任何中文字体时 throw(不静默产出豆腐块)", () => {
	assert.throws(
		() => resolveAssFont({ platform: "linux", fcList: () => "" }),
		/未检测到中文字体/,
	);
	assert.throws(
		() => resolveAssFont({ platform: "win32", fontsDir: "C:\\Windows\\Fonts", checkExists: () => false }),
		/缺少中文字体/,
	);
});

test("buildAssFile: fontName 参数透传到 Style 行(默认 Microsoft YaHei)", () => {
	const ass = buildAssFile([], { videoWidth: 1920, videoHeight: 1080, fontName: "Noto Sans CJK SC" });
	assert.match(ass, /Style: Default,Noto Sans CJK SC,/);
	// 默认值向后兼容
	const assDefault = buildAssFile([], { videoWidth: 1920, videoHeight: 1080 });
	assert.match(assDefault, /Style: Default,Microsoft YaHei,/);
});

test("buildHardsubArgs: fontsdir 可选,传入时加进 subtitles filter", () => {
	const withFonts = buildHardsubArgs({ inputPath: "in.mp4", subtitlePath: "sub.ass", outputPath: "out.mp4", fontsdir: "/usr/share/fonts" });
	const vf = withFonts.find((a) => typeof a === "string" && a.startsWith("subtitles="));
	assert.match(vf, /fontsdir=\/usr\/share\/fonts/);
	// 不传时无 fontsdir(向后兼容)
	const noFonts = buildHardsubArgs({ inputPath: "in.mp4", subtitlePath: "sub.ass", outputPath: "out.mp4" });
	const vf2 = noFonts.find((a) => typeof a === "string" && a.startsWith("subtitles="));
	assert.ok(!vf2.includes("fontsdir"));
});

// === 缺陷8:音频/视频时长预警 ===

test("audioVideoDurationStatus: 音频短于/等于视频 = ok", () => {
	assert.equal(audioVideoDurationStatus(100, 120).ok, true);
	assert.equal(audioVideoDurationStatus(120, 120).ok, true);
});

test("audioVideoDurationStatus: 音频微长于视频(< 5s 且 < 5%)放行", () => {
	// 视频 200s,音频 203s(delta=3s < max(5,10)=10)→ 放行
	assert.equal(audioVideoDurationStatus(203, 200).ok, true);
});

test("audioVideoDurationStatus: 音频显著长于视频预警(会截断)", () => {
	// 视频 100s,音频 130s(delta=30s > max(5, 100*5%=5)=5s)→ 预警
	const status = audioVideoDurationStatus(130, 100);
	assert.equal(status.ok, false);
	assert.match(status.reason, /会被截断/);
	assert.ok(status.deltaSec > 5);
});

test("audioVideoDurationStatus: 短视频用绝对阈值(5s)收紧", () => {
	// ponytail: 真实验证发现的边界 bug——5s 视频配 15s 音频(delta=10s)是 3 倍异常,
	// 旧 max(10,...) 阈值让 delta=10 刚好放行。改 max(5,...) 后正确拦截。
	assert.equal(audioVideoDurationStatus(15, 5).ok, false);
	// 边界:delta 刚好 5s 等于阈值,用 > 不触发(5 不 > 5)
	assert.equal(audioVideoDurationStatus(10, 5).ok, true);
	// delta 6s > 5s 触发
	assert.equal(audioVideoDurationStatus(11, 5).ok, false);
});

test("audioVideoDurationStatus: 长视频用百分比阈值(5%)", () => {
	// 视频 600s,音频 625s(delta=25s < max(5,30)=30)→ 放行
	assert.equal(audioVideoDurationStatus(625, 600).ok, true);
	// 视频 600s,音频 640s(delta=40s > 30s)→ 预警
	assert.equal(audioVideoDurationStatus(640, 600).ok, false);
});

test("audioVideoDurationStatus: 非法时长返回 not ok", () => {
	assert.equal(audioVideoDurationStatus(0, 100).ok, false);
	assert.equal(audioVideoDurationStatus(NaN, 100).ok, false);
	assert.equal(audioVideoDurationStatus(100, -1).ok, false);
});

