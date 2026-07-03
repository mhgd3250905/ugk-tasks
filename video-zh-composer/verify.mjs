import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const outputDir = process.env.TASK_OUTPUT_DIR;
const failures = [];

function fail(assertion, expected, actual, hint) {
	failures.push({ assertion, expected, actual, ...(hint ? { hint } : {}) });
}

function readJson(name) {
	const filePath = join(outputDir, name);
	if (!existsSync(filePath)) {
		fail(`${name} exists`, "file exists", "missing", filePath);
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		fail(`${name} is valid JSON`, "parseable JSON", error.message);
		return undefined;
	}
}

function subtitleCueTextLines(text) {
	const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
	const cues = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line.includes("-->")) continue;
		const textLines = [];
		index += 1;
		while (index < lines.length && lines[index].trim()) {
			textLines.push(lines[index]);
			index += 1;
		}
		cues.push(textLines);
	}
	return cues;
}

function probeMedia(name, requiredStreams) {
	const filePath = join(outputDir, name);
	if (!existsSync(filePath)) {
		fail(`${name} exists`, "file exists", "missing", filePath);
		return undefined;
	}
	const size = statSync(filePath).size;
	if (size <= 1024 * 1024) fail(`${name} size`, "> 1 MiB", `${size} bytes`);
	try {
		const probe = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath], { encoding: "utf8" });
		const info = JSON.parse(probe);
		const streams = Array.isArray(info.streams) ? info.streams : [];
		const duration = Number(info.format?.duration);
		if (!Number.isFinite(duration) || duration <= 0) fail(`${name} duration`, "duration > 0", String(info.format?.duration));
		for (const type of requiredStreams) {
			if (!streams.some((stream) => stream.codec_type === type)) fail(`${name} ${type} stream`, `${type} stream exists`, "missing");
		}
		return { duration, streams };
	} catch (error) {
		fail(`${name} ffprobe`, "ffprobe parses media", error.message);
		return undefined;
	}
}

if (!outputDir || !existsSync(outputDir)) {
	fail("TASK_OUTPUT_DIR exists", "existing output directory", outputDir || "missing");
} else {
	const summary = readJson("compose-summary.json");
	const finalMedia = probeMedia("final.zh.mp4", ["video", "audio", "subtitle"]);
	const hardsubMedia = probeMedia("final.zh.hardsub.mp4", ["video", "audio"]);
	// ponytail 缺陷2加固:查 final.mp4 视频编码。脚本已把 VP9 转成 h264,这里抓"转码后仍是 webm 系编码"的异常。
	if (finalMedia?.streams) {
		const videoStream = finalMedia.streams.find((s) => s.codec_type === "video");
		const codec = String(videoStream?.codec_name || "").toLowerCase();
		if (codec === "vp9" || codec === "vp8" || codec === "theora") {
			fail("final.zh.mp4 video codec", "h264/hevc/av1 (MP4-friendly)", `${codec} (not widely playable in MP4 container)`);
		}
	}
	if (summary) {
		for (const key of ["videoPath", "audioPath", "subtitlePath", "finalVideoPath", "hardsubVideoPath", "subtitleColor"]) {
			if (!summary[key]) fail(`compose-summary.${key}`, "non-empty value", JSON.stringify(summary[key]));
		}
		if (summary.finalVideoPath && !existsSync(summary.finalVideoPath)) fail("compose-summary.finalVideoPath exists", "existing file", JSON.stringify(summary.finalVideoPath));
		if (summary.hardsubVideoPath && !existsSync(summary.hardsubVideoPath)) fail("compose-summary.hardsubVideoPath exists", "existing file", JSON.stringify(summary.hardsubVideoPath));
		if (!summary.localSubtitlePath || !existsSync(summary.localSubtitlePath)) fail("compose-summary.localSubtitlePath exists", "existing subtitle copy", JSON.stringify(summary.localSubtitlePath));
		if (!summary.hardsubSubtitlePath || !existsSync(summary.hardsubSubtitlePath)) {
			fail("compose-summary.hardsubSubtitlePath exists", "existing hardsub subtitle copy", JSON.stringify(summary.hardsubSubtitlePath));
		} else {
			// ponytail 竖屏修复:硬字幕改 ASS 格式。检查 ASS 结构合法(三段齐全 + 有 Dialogue)。
			// 旧的"每屏≤2行"检查已废弃(ASS 字号自适应后不需要硬性行数限制)。
			const assText = readFileSync(summary.hardsubSubtitlePath, "utf8");
			if (!assText.includes("[Script Info]") || !assText.includes("[V4+ Styles]") || !assText.includes("[Events]")) {
				fail("hardsub ASS structure", "[Script Info]/[V4+ Styles]/[Events]", "missing section");
			}
			if (!/^Dialogue:/m.test(assText)) {
				fail("hardsub ASS has dialogue", "at least one Dialogue line", "none");
			}
		}
		if (!["white", "yellow", "pink"].includes(String(summary.subtitleColor))) fail("compose-summary.subtitleColor", "white|yellow|pink", JSON.stringify(summary.subtitleColor));
		const videoDuration = Number(summary.videoDurationSeconds);
		if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
			fail("compose-summary.videoDurationSeconds", "duration > 0", String(summary.videoDurationSeconds));
		} else {
			if (finalMedia && finalMedia.duration < videoDuration - 0.75) {
				fail("final.zh.mp4 preserves video duration", `>= ${videoDuration - 0.75}s`, `${finalMedia.duration}s`);
			}
			if (hardsubMedia && hardsubMedia.duration < videoDuration - 0.75) {
				fail("final.zh.hardsub.mp4 preserves video duration", `>= ${videoDuration - 0.75}s`, `${hardsubMedia.duration}s`);
			}
		}
		// ponytail 缺陷8加固:final.mp4 的音视频时长一致性。配音被截断/视频被截都会让 audio≠video。
		if (finalMedia?.streams) {
			const audioStream = finalMedia.streams.find((s) => s.codec_type === "audio");
			const audioDur = Number(audioStream?.duration);
			const videoStream = finalMedia.streams.find((s) => s.codec_type === "video");
			const videoDur = Number(videoStream?.duration);
			if (Number.isFinite(audioDur) && Number.isFinite(videoDur) && videoDur > 0) {
				const delta = Math.abs(audioDur - videoDur);
				const threshold = Math.max(1, videoDur * 0.05);
				if (delta > threshold) {
					fail("final.zh.mp4 audio/video sync", `|audio-video| <= ${threshold.toFixed(1)}s`, `audio=${audioDur.toFixed(1)}s video=${videoDur.toFixed(1)}s delta=${delta.toFixed(1)}s`);
				}
			}
		}
	}
}

if (failures.length > 0) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
process.exit(0);
