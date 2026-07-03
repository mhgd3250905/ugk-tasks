import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUBTITLE_COLOURS = {
	white: "&H00FFFFFF",
	yellow: "&H0000FFFF",
	pink: "&H00B469FF",
};
const BREAK_PUNCTUATION = "，。！？；：、,.!?;:";
const STRONG_BREAK_PUNCTUATION = "。！？!?";
const LINE_START_FORBIDDEN = "，。！？；：、,.!?;:)]）】》」』”’";

function normalizeSubtitleColor(value = "white") {
	const color = String(value || "white").toLowerCase();
	if (SUBTITLE_COLOURS[color]) return color;
	throw new Error("subtitleColor must be white, yellow, or pink");
}

// ponytail 竖屏修复:字号按视频高度动态算(约屏幕高4.5%),不固定。
// 配 ASS PlayResY=视频高度,渲染就是 1:1 这个像素值,横竖屏自适应。
export function fontSizeForVideo(videoHeight) {
	const height = Number(videoHeight) || 720;
	return Math.max(16, Math.round(height * 0.045));
}

// ponytail 竖屏修复:换行字数基于字号算(CJK约1em/字),不再按 width/64。
// videoWidth/fontSize = 满宽能放的CJK字数,留5%安全边际。
export function subtitleWrapChars(videoWidth, fontSize) {
	const width = Number(videoWidth) || 1280;
	const fs = Number(fontSize) || fontSizeForVideo(720);
	return Math.max(8, Math.floor(width / fs * 0.95));
}

function subtitleChars(text) {
	return Array.from(String(text || "").replace(/\s+/g, " ").trim());
}

function isLatinWordChar(char) {
	return /^[A-Za-z0-9]$/u.test(char || "");
}

function avoidLatinWordCut(chars, cut) {
	let next = cut;
	while (next > 0 && next < chars.length && isLatinWordChar(chars[next - 1]) && isLatinWordChar(chars[next])) {
		next += 1;
	}
	while (next < chars.length && LINE_START_FORBIDDEN.includes(chars[next])) {
		next += 1;
	}
	return next;
}

function lineBreakIndex(chars, limit) {
	const nearEnd = chars.length <= limit * 2;
	const min = nearEnd ? Math.max(1, chars.length - limit) : Math.max(1, Math.floor(limit * 0.55));
	const max = Math.min(chars.length - 1, nearEnd ? limit + 1 : limit - 1);
	for (let index = max; index >= min; index -= 1) {
		if (STRONG_BREAK_PUNCTUATION.includes(chars[index])) return index + 1;
	}
	for (let index = max; index >= min; index -= 1) {
		if (BREAK_PUNCTUATION.includes(chars[index])) return index + 1;
	}
	const cut = LINE_START_FORBIDDEN.includes(chars[limit]) ? Math.min(chars.length, limit + 1) : Math.min(chars.length, limit);
	return avoidLatinWordCut(chars, cut);
}

function chunkBreakIndex(chars, maxChars) {
	const min = Math.max(1, Math.floor(maxChars * 0.55));
	for (let index = Math.min(maxChars - 1, chars.length - 1); index >= min; index -= 1) {
		if (STRONG_BREAK_PUNCTUATION.includes(chars[index])) return index + 1;
	}
	for (let index = Math.min(maxChars - 1, chars.length - 1); index >= min; index -= 1) {
		if (BREAK_PUNCTUATION.includes(chars[index])) return index + 1;
	}
	const cut = LINE_START_FORBIDDEN.includes(chars[maxChars]) ? Math.min(chars.length, maxChars + 1) : Math.min(chars.length, maxChars);
	return avoidLatinWordCut(chars, cut);
}

export function wrapSubtitleText(text, maxChars = 20) {
	const limit = Math.max(1, Number(maxChars) || 20);
	let chars = subtitleChars(text);
	const lines = [];
	while (chars.length > limit) {
		const cut = lineBreakIndex(chars, limit);
		lines.push(chars.slice(0, cut).join(""));
		chars = chars.slice(cut);
	}
	if (chars.length) lines.push(chars.join(""));
	return lines.join("\n");
}

export function splitSubtitleText(text, maxChars = 20) {
	const limit = Math.max(1, Number(maxChars) || 20);
	const maxChunkChars = limit * 2;
	let chars = subtitleChars(text);
	const chunks = [];
	while (chars.length > maxChunkChars) {
		const cut = chunkBreakIndex(chars, maxChunkChars);
		chunks.push(chars.slice(0, cut).join(""));
		chars = chars.slice(cut);
	}
	if (chars.length) chunks.push(chars.join(""));
	return chunks;
}

function parseSubtitleTime(value) {
	const normalized = String(value || "").trim().replace(",", ".");
	const [clock, fraction = "0"] = normalized.split(".");
	const parts = clock.split(":").map((part) => Number(part));
	const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
	return (((hours * 60 + minutes) * 60 + seconds) * 1000) + Number(fraction.padEnd(3, "0").slice(0, 3));
}

function formatSubtitleTime(ms, separator) {
	const value = Math.max(0, Math.floor(ms));
	const hours = Math.floor(value / 3600000);
	const minutes = Math.floor((value % 3600000) / 60000);
	const seconds = Math.floor((value % 60000) / 1000);
	const millis = value % 1000;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

function parseSubtitleTiming(line) {
	const [startRaw, rest] = String(line || "").split("-->");
	if (!rest) return null;
	const endRaw = rest.trim().split(/\s+/)[0];
	return {
		startMs: parseSubtitleTime(startRaw),
		endMs: parseSubtitleTime(endRaw),
		separator: startRaw.includes(",") || endRaw.includes(",") ? "," : ".",
	};
}

// ponytail 竖屏修复:解析字幕 + 换行 + 拆cue,返回结构化 cue 数组(纯函数,可测)。
// 从原 wrapSubtitleFile 抽出,既可输出 SRT(软字幕/兼容)也可输出 ASS(硬字幕,治竖屏)。
export function parseAndWrapCues(text, maxChars) {
	const limit = Math.max(1, Number(maxChars) || 20);
	const normalized = String(text || "").replace(/\r/g, "");
	const cues = [];
	for (const block of normalized.split(/\n{2,}/)) {
		const lines = block.split("\n");
		const timingIndex = lines.findIndex((line) => line.includes("-->"));
		if (timingIndex < 0) continue;
		const timing = parseSubtitleTiming(lines[timingIndex]);
		if (!timing || timing.endMs <= timing.startMs) continue;
		const chunks = splitSubtitleText(lines.slice(timingIndex + 1).join(" "), limit);
		const duration = timing.endMs - timing.startMs;
		chunks.forEach((chunk, chunkIndex) => {
			const startMs = Math.floor(timing.startMs + (duration * chunkIndex) / chunks.length);
			const endMs = chunkIndex === chunks.length - 1
				? timing.endMs
				: Math.floor(timing.startMs + (duration * (chunkIndex + 1)) / chunks.length);
			cues.push({
				startMs,
				endMs: Math.max(startMs + 1, endMs),
				text: wrapSubtitleText(chunk, limit),
			});
		});
	}
	return cues;
}

// ASS 时间格式:H:MM:SS.cc(百分秒,2位)。SRT 毫秒四舍五入到百分秒。
function formatAssTime(ms) {
	const value = Math.max(0, Math.floor(ms));
	const hours = Math.floor(value / 3600000);
	const minutes = Math.floor((value % 3600000) / 60000);
	const seconds = Math.floor((value % 60000) / 1000);
	const centiseconds = Math.round((value % 1000) / 10);
	return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

// ponytail 竖屏修复核心:把 cue 数组转成完整 ASS 文件。
// 设 PlayResX=视频宽/PlayResY=视频高 → 字号1:1可控,横竖屏通用不超宽不变形。
// ASS 自带样式,ffmpeg subtitles 烧录时不需要 force_style。
export function buildAssFile(cues, options = {}) {
	const videoWidth = Number(options.videoWidth) || 1280;
	const videoHeight = Number(options.videoHeight) || 720;
	const fontSize = Number(options.fontSize) || fontSizeForVideo(videoHeight);
	const fontName = String(options.fontName || "Microsoft YaHei");
	const marginV = Math.max(12, Math.round(videoHeight * 0.03));
	const color = SUBTITLE_COLOURS[normalizeSubtitleColor(options.subtitleColor)] || SUBTITLE_COLOURS.white;
	const colourAss = color.endsWith("&") ? color : `${color}&`;
	const lines = [
		"[Script Info]",
		"ScriptType: v4.00+",
		`PlayResX: ${videoWidth}`,
		`PlayResY: ${videoHeight}`,
		"WrapStyle: 2",
		"ScaledBorderAndShadow: yes",
		"",
		"[V4+ Styles]",
		"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
		`Style: Default,${fontName},${fontSize},${colourAss},&H000000FF&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,2,1,2,${Math.round(videoWidth * 0.03)},${Math.round(videoWidth * 0.03)},${marginV},1`,
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
	];
	for (const cue of cues) {
		// ASS 硬换行用 \N(大写)。SRT/内部的 \n 换行映射过去。
		const text = String(cue.text || "").replace(/\r/g, "").replace(/\n/g, "\\N");
		lines.push(`Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(cue.endMs)},Default,,0,0,0,,${text}`);
	}
	return `${lines.join("\n")}\n`;
}

export function wrapSubtitleFile(text, maxChars) {
	const normalized = String(text || "").replace(/\r/g, "");
	const endsWithNewline = normalized.endsWith("\n");
	let nextIndex = 1;
	const blocks = normalized.split(/\n{2,}/).map((block) => {
		const lines = block.split("\n");
		const timingIndex = lines.findIndex((line) => line.includes("-->"));
		if (timingIndex < 0) return block;
		const timing = parseSubtitleTiming(lines[timingIndex]);
		if (!timing || timing.endMs <= timing.startMs) return block;
		const hasIndex = timingIndex > 0 && /^\d+$/.test(lines[timingIndex - 1].trim());
		const chunks = splitSubtitleText(lines.slice(timingIndex + 1).join(" "), maxChars);
		const duration = timing.endMs - timing.startMs;
		return chunks.map((chunk, chunkIndex) => {
			const startMs = Math.floor(timing.startMs + (duration * chunkIndex) / chunks.length);
			const endMs = chunkIndex === chunks.length - 1
				? timing.endMs
				: Math.floor(timing.startMs + (duration * (chunkIndex + 1)) / chunks.length);
			const out = [];
			if (hasIndex) out.push(String(nextIndex));
			nextIndex += 1;
			out.push(`${formatSubtitleTime(startMs, timing.separator)} --> ${formatSubtitleTime(Math.max(startMs + 1, endMs), timing.separator)}`);
			out.push(...wrapSubtitleText(chunk, maxChars).split("\n"));
			return out.join("\n");
		}).join("\n\n");
	});
	return `${blocks.join("\n\n")}${endsWithNewline ? "\n" : ""}`;
}

export function parseCliArgs(argv) {
	const out = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) continue;
		if (arg === "--preflight") {
			out.preflight = true;
			continue;
		}
		const value = argv[index + 1];
		index += 1;
		switch (arg) {
			case "--video":
				out.videoPath = value;
				break;
			case "--audio":
				out.audioPath = value;
				break;
			case "--subtitle":
				out.subtitlePath = value;
				break;
			case "--output-dir":
				out.outputDir = value;
				break;
			case "--subtitle-color":
				out.subtitleColor = normalizeSubtitleColor(value);
				break;
			default:
				throw new Error(`Unknown flag: ${arg}`);
		}
	}
	return out;
}

export function buildFinalMuxArgs({ videoPath, audioPath, subtitlePath, outputPath, durationSeconds, copyVideo = true }) {
	const videoCodecArgs = copyVideo
		? ["-c:v", "copy"]
		: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"];
	const durationArgs = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0
		? ["-t", Number(durationSeconds).toFixed(3)]
		: ["-shortest"];
	return [
		"-y",
		"-hide_banner",
		"-loglevel", "error",
		"-i", videoPath,
		"-i", audioPath,
		"-i", subtitlePath,
		"-map", "0:v:0",
		"-map", "1:a:0",
		"-map", "2:0",
		...videoCodecArgs,
		"-c:a", "aac",
		"-b:a", "192k",
		"-af", "apad",
		"-c:s", "mov_text",
		"-metadata:s:a:0", "language=zho",
		"-metadata:s:s:0", "language=zho",
		...durationArgs,
		outputPath,
	];
}

// ponytail 竖屏修复:烧录 ASS 不需要 force_style(ASS 自带 [V4+ Styles] 样式)。
// 字号/颜色/PlayRes 都在 ASS 文件里定了,这里只做纯烧录。
// fontsdir(可选):libass 定位字体的辅助目录,非 Windows 无系统字体路径时帮助找到中文字体。
export function buildHardsubArgs({ inputPath, subtitlePath, outputPath, fontsdir }) {
	const filter = fontsdir
		? `subtitles=${subtitlePath}:fontsdir=${fontsdir}`
		: `subtitles=${subtitlePath}`;
	return [
		"-y",
		"-hide_banner",
		"-loglevel", "error",
		"-i", inputPath,
		"-vf", filter,
		"-c:v", "libx264",
		"-preset", "veryfast",
		"-crf", "20",
		"-c:a", "copy",
		outputPath,
	];
}

async function run(command, args, options = {}) {
	const child = spawn(command, args, { cwd: options.cwd, windowsHide: true });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		if (options.streamStdout) process.stdout.write(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
		if (options.streamStderr) process.stderr.write(chunk);
	});
	const exitCode = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${exitCode}:\n${stderr || stdout}`);
	return { stdout, stderr };
}

async function requireCommand(command, args) {
	await run(command, args);
}

function ffprobeInfo(filePath) {
	const probe = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath], { encoding: "utf8" });
	return JSON.parse(probe);
}

function durationSeconds(filePath) {
	const duration = Number(ffprobeInfo(filePath).format?.duration);
	if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid media duration for ${filePath}`);
	return duration;
}

// ponytail 防呆 C3:拿不到视频流时抛错,不再静默回退1280×720。
// 视频文件损坏/无视频流应失败,不偷偷按错误尺寸算字幕(会导致字幕换行/字号全错)。
function videoSize(filePath) {
	const stream = ffprobeInfo(filePath).streams?.find((item) => item.codec_type === "video");
	const width = Number(stream?.width);
	const height = Number(stream?.height);
	if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
		throw new Error(`videoSize: no valid video stream in ${filePath} (needs a real video file with width/height)`);
	}
	return { width, height };
}

// ponytail 缺陷2修复:VP9/VP8 进 MP4 容器被 ffmpeg 拒绝(copy 失败再回退转码浪费一轮全量转码)。
// 在 preflight 阶段读 codec_name,需转码的直接走 libx264,不再"先 copy 失败再 fallback"。
function videoCodecName(filePath) {
	const stream = ffprobeInfo(filePath).streams?.find((item) => item.codec_type === "video");
	return String(stream?.codec_name || "").toLowerCase();
}

// MP4 容器标准不支持 copy 的编码(VP8/VP9 是 webm 家族,copy 进 mp4 会被 ffmpeg 拒)。
// h264/hevc/av1 是 MP4 标准编码,new ffmpeg 的 av1 也支持 copy。
export function needsTranscode(codecName) {
	const codec = String(codecName || "").toLowerCase();
	return codec === "vp9" || codec === "vp8" || codec === "theora";
}

// ponytail 缺陷3修复:硬字幕 ASS 硬编码 Microsoft YaHei,非 Windows 无此字体 → 豆腐块假通过。
// 检测当前系统可用的中文字体,无则明确 throw(比静默产出方框视频好)。
const WINDOWS_CJK_FONTS = [
	{ file: "msyh.ttc", name: "Microsoft YaHei" },
	{ file: "msyhbd.ttc", name: "Microsoft YaHei" },
	{ file: "simhei.ttf", name: "SimHei" },
	{ file: "simsun.ttc", name: "SimSun" },
];
const POSIX_CJK_FONT_CANDIDATES = ["Noto Sans CJK SC", "PingFang SC", "Source Han Sans SC", "WenQuanYi Micro Hei", "WenQuanYi Zen Hei"];

export function resolveAssFont(options = {}) {
	const platform = options.platform || process.platform;
	const checkExists = options.checkExists || ((p) => existsSync(p));
	// Windows:查 Fonts 目录的字体文件
	if (platform === "win32") {
		const fontsDir = options.fontsDir || path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
		for (const font of WINDOWS_CJK_FONTS) {
			if (checkExists(path.join(fontsDir, font.file))) return font.name;
		}
	}
	// macOS/Linux:用 fc-list 找中文字体(若可用)
	if (typeof options.fcList === "function") {
		try {
			const list = String(options.fcList() || "");
			for (const candidate of POSIX_CJK_FONT_CANDIDATES) {
				if (list.includes(candidate)) return candidate;
			}
		} catch {
			// fc-list 不可用,走 fallback
		}
	}
	// 检测不到任何已知中文字体
	const hint = platform === "win32"
		? "Windows 上缺少中文字体,请确认 C:\\Windows\\Fonts 下有 msyh.ttc 或 simhei.ttf"
		: "未检测到中文字体,请安装 fonts-noto-cjk(Noto Sans CJK SC)或 WenQuanYi,或确保 fc-list 可用";
	throw new Error(`resolveAssFont: ${hint}`);
}

// ponytail 缺陷8修复:音频显著长于视频时 -t 会截断音频,后半段静音、配音丢失。
// 阈值 max(5s, 视频5%):5s 绝对值容编码误差和 TTS 轻微漂移;5% 让长视频用百分比收紧。
// 实测校准:5s 视频配 15s 音频(delta=10 > max(5,0.25)=5)触发;600s 视频配 625s 音频(delta=25 < 30)放行。
export function audioVideoDurationStatus(audioSec, videoSec) {
	const audio = Number(audioSec);
	const video = Number(videoSec);
	if (!Number.isFinite(audio) || !Number.isFinite(video) || audio <= 0 || video <= 0) {
		return { ok: false, reason: "invalid duration", deltaSec: NaN };
	}
	const delta = audio - video;
	const threshold = Math.max(5, video * 0.05);
	if (delta > threshold) {
		return { ok: false, reason: `音频比视频长 ${delta.toFixed(1)}s(超阈值 ${threshold.toFixed(1)}s),合成时音频会被截断、后半段配音丢失`, deltaSec: delta };
	}
	return { ok: true, reason: "ok", deltaSec: delta };
}

function parseTaskInput(env) {
	try {
		return JSON.parse(env.TASK_INPUT || "{}");
	} catch {
		return {};
	}
}

function requiredPath(value, name) {
	const resolved = value ? path.resolve(String(value)) : "";
	if (!resolved) throw new Error(`${name} is required`);
	if (!existsSync(resolved)) throw new Error(`${name} does not exist: ${resolved}`);
	return resolved;
}

function resolveInput(argv = process.argv.slice(2), env = process.env) {
	const cli = parseCliArgs(argv);
	const taskInput = parseTaskInput(env);
	const outputDir = path.resolve(cli.outputDir || env.TASK_OUTPUT_DIR || taskInput.outputDir || "");
	if (!outputDir) throw new Error("TASK_OUTPUT_DIR or --output-dir is required");
	return {
		preflight: Boolean(cli.preflight),
		videoPath: requiredPath(cli.videoPath || taskInput.videoPath, "videoPath"),
		audioPath: requiredPath(cli.audioPath || taskInput.audioPath, "audioPath"),
		subtitlePath: requiredPath(cli.subtitlePath || taskInput.subtitlePath, "subtitlePath"),
		outputDir,
		subtitleColor: normalizeSubtitleColor(cli.subtitleColor || taskInput.subtitleColor || "white"),
	};
}

function localSubtitleName(subtitlePath) {
	const ext = path.extname(subtitlePath).toLowerCase();
	return ext === ".vtt" ? "subtitle.zh.vtt" : "subtitle.zh.srt";
}

// ponytail 竖屏修复:硬字幕统一用 .ass(不再随软字幕扩展名)。
function hardsubSubtitleName(subtitleName) {
	const base = path.basename(subtitleName, path.extname(subtitleName));
	return `${base}.hardsub.ass`;
}

async function compose(input) {
	await mkdir(input.outputDir, { recursive: true });
	const subtitleName = localSubtitleName(input.subtitlePath);
	const localSubtitlePath = path.join(input.outputDir, subtitleName);
	await copyFile(input.subtitlePath, localSubtitlePath);
	const hardsubName = hardsubSubtitleName(subtitleName);
	const size = videoSize(input.videoPath);
	// ponytail 竖屏修复:硬字幕走 ASS(PlayRes=视频尺寸,字号1:1),不再用 SRT。
	const fontSize = fontSizeForVideo(size.height);
	const cues = parseAndWrapCues(await readFile(localSubtitlePath, "utf8"), subtitleWrapChars(size.width, fontSize));
	// ponytail 缺陷3修复:字体由 preflight 检测后传入(默认 Microsoft YaHei 向后兼容)。
	const fontName = input.assFontName || "Microsoft YaHei";
	await writeFile(
		path.join(input.outputDir, hardsubName),
		buildAssFile(cues, { videoWidth: size.width, videoHeight: size.height, fontSize, fontName, subtitleColor: input.subtitleColor }),
		"utf8",
	);
	const finalVideoPath = path.join(input.outputDir, "final.zh.mp4");
	// ponytail 缺陷2修复:preflight 已按 codec 预判 copyVideo,主路径直接用,不再先 copy 失败再 fallback。
	// copyVideo 由 main 算出(VP9/VP8 → false);保留 try-catch 作边缘编码的最后兜底。
	const copyVideo = input.copyVideo !== false;
	try {
		await run("ffmpeg", buildFinalMuxArgs({
			videoPath: input.videoPath,
			audioPath: input.audioPath,
			subtitlePath: subtitleName,
			outputPath: "final.zh.mp4",
			durationSeconds: input.videoDurationSeconds,
			copyVideo,
		}), { cwd: input.outputDir });
	} catch (error) {
		if (!copyVideo) throw error; // 已经是转码路径还失败,不再重试
		console.error(`[mux] video stream copy failed, retrying with h264 transcode: ${error.message}`);
		await run("ffmpeg", buildFinalMuxArgs({
			videoPath: input.videoPath,
			audioPath: input.audioPath,
			subtitlePath: subtitleName,
			outputPath: "final.zh.mp4",
			durationSeconds: input.videoDurationSeconds,
			copyVideo: false,
		}), { cwd: input.outputDir, streamStderr: true });
	}
	const hardsubVideoPath = path.join(input.outputDir, "final.zh.hardsub.mp4");
	await run("ffmpeg", buildHardsubArgs({
		inputPath: "final.zh.mp4",
		subtitlePath: hardsubName,
		outputPath: "final.zh.hardsub.mp4",
		subtitleColor: input.subtitleColor,
	}), { cwd: input.outputDir });
	return { finalVideoPath, hardsubVideoPath, subtitleName, hardsubName };
}

async function main() {
	const input = resolveInput();
	await mkdir(input.outputDir, { recursive: true });
	await requireCommand("ffmpeg", ["-version"]);
	await requireCommand("ffprobe", ["-version"]);
	const videoDurationSeconds = durationSeconds(input.videoPath);
	const audioDurationSeconds = durationSeconds(input.audioPath);

	// ponytail 防呆 C4:空输入检查。空字幕/静音音频/零时长视频应打回,
	// 不产出"成功但无内容"的视频。在 preflight 就拦,避免白跑合成。
	const subtitleText = await readFile(input.subtitlePath, "utf8");
	const subtitleCueCount = (subtitleText.match(/-->/g) || []).length;
	if (subtitleCueCount === 0) {
		throw new Error(`subtitlePath has no cues: ${input.subtitlePath} (needs a subtitle with at least one timed cue)`);
	}

	// ponytail 缺陷2修复:preflight 读 codec,VP9/VP8 直接走 transcode(省一轮 copy 失败)。
	const videoCodec = videoCodecName(input.videoPath);
	const copyVideo = !needsTranscode(videoCodec);
	if (!copyVideo) console.log(`[mux] video codec ${videoCodec} needs transcode (not MP4-container-compatible), using libx264`);

	// ponytail 缺陷3修复:preflight 检测中文字体,无则明确 throw(比豆腐块假通过好)。
	const assFontName = resolveAssFont();

	// ponytail 缺陷8修复:音频显著长于视频时预警(配音会被 -t 截断、后半段静音)。
	const durationStatus = audioVideoDurationStatus(audioDurationSeconds, videoDurationSeconds);
	if (!durationStatus.ok) {
		throw new Error(`audio/video duration mismatch: ${durationStatus.reason}. video=${videoDurationSeconds}s audio=${audioDurationSeconds}s. 请检查上游 TTS 是否语速过慢导致配音超出视频。`);
	}

	if (input.preflight) {
		console.log(JSON.stringify({
			ok: true,
			videoPath: input.videoPath,
			audioPath: input.audioPath,
			subtitlePath: input.subtitlePath,
			subtitleColor: input.subtitleColor,
			videoDurationSeconds,
			audioDurationSeconds,
			videoCodec,
			copyVideo,
			assFontName,
		}, null, 2));
		return;
	}
	input.videoDurationSeconds = videoDurationSeconds;
	input.audioDurationSeconds = audioDurationSeconds;
	input.copyVideo = copyVideo;
	input.assFontName = assFontName;
	const result = await compose(input);
	const summary = {
		videoPath: input.videoPath,
		audioPath: input.audioPath,
		subtitlePath: input.subtitlePath,
		localSubtitlePath: path.join(input.outputDir, result.subtitleName),
		hardsubSubtitlePath: path.join(input.outputDir, result.hardsubName),
		finalVideoPath: result.finalVideoPath,
		hardsubVideoPath: result.hardsubVideoPath,
		subtitleColor: input.subtitleColor,
		videoDurationSeconds,
		audioDurationSeconds,
	};
	await writeFile(path.join(input.outputDir, "compose-summary.json"), JSON.stringify(summary, null, 2), "utf8");
	console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
