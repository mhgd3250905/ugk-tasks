import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const outputDir = process.env.TASK_OUTPUT_DIR;
const taskInput = JSON.parse(process.env.TASK_INPUT || "{}");
const supportedVoices = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];
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

function checkNotSilent(filePath, label) {
	const result = spawnSync("ffmpeg", ["-v", "info", "-i", filePath, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
	const match = `${result.stdout || ""}\n${result.stderr || ""}`.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
	const mean = match ? Number(match[1]) : undefined;
	if (!Number.isFinite(mean) || mean <= -80) fail(`${label} non-silent`, "mean_volume > -80 dB", Number.isFinite(mean) ? `${mean} dB` : "missing mean_volume");
}

function checkSegmentCount(segmentDir, summary) {
	const expected = Number(summary?.speechGroupCount);
	if (!Number.isFinite(expected) || expected <= 0 || !existsSync(segmentDir)) return;
	const names = readdirSync(segmentDir);
	const fitCount = names.filter((name) => /^\d{4}-fit\.wav$/u.test(name)).length;
	const metaCount = names.filter((name) => /^\d{4}\.json$/u.test(name)).length;
	if (fitCount !== expected) fail("tts-segments fit count", String(expected), String(fitCount));
	if (metaCount !== expected) fail("tts-segments metadata count", String(expected), String(metaCount));
}

if (!outputDir || !existsSync(outputDir)) {
	fail("TASK_OUTPUT_DIR exists", "existing output directory", outputDir || "missing");
} else {
	const cues = readJson("source.cues.json");
	const summary = readJson("tts-summary.json");
	const dubPath = join(outputDir, "dub.zh.wav");
	const segmentDir = join(outputDir, "tts-segments");
	if (!Array.isArray(cues) || cues.length === 0) fail("source.cues.json cue count", "cue count > 0", JSON.stringify(cues?.length));
	if (!existsSync(segmentDir)) fail("tts-segments exists", "directory exists", "missing", segmentDir);
	if (!existsSync(dubPath)) {
		fail("dub.zh.wav exists", "file exists", "missing", dubPath);
	} else {
		const size = statSync(dubPath).size;
		if (size <= 1024) fail("dub.zh.wav size", "> 1 KiB", `${size} bytes`);
		try {
			const probe = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", dubPath], { encoding: "utf8" });
			const info = JSON.parse(probe);
			const duration = Number(info.format?.duration);
			if (!Number.isFinite(duration) || duration <= 0) fail("dub.zh.wav duration", "duration > 0", String(info.format?.duration));
			if (Number.isFinite(duration) && Array.isArray(cues) && cues.length > 0) {
				const expectedSeconds = Number(cues[cues.length - 1].endMs) / 1000;
				if (duration + 0.5 < expectedSeconds) {
					fail("dub.zh.wav covers subtitle timeline", `>= ${expectedSeconds.toFixed(3)}s`, `${duration.toFixed(3)}s`);
				}
			}
			if (!Array.isArray(info.streams) || !info.streams.some((stream) => stream.codec_type === "audio")) {
				fail("dub.zh.wav audio stream", "audio stream exists", "missing");
			}
		} catch (error) {
			fail("dub.zh.wav ffprobe", "ffprobe parses audio", error.message);
		}
		checkNotSilent(dubPath, "dub.zh.wav");
	}
	if (summary) {
		if (!summary.subtitlePath) fail("tts-summary.subtitlePath", "non-empty path", JSON.stringify(summary.subtitlePath));
		if (!summary.dubAudioPath || !existsSync(summary.dubAudioPath)) fail("tts-summary.dubAudioPath exists", "existing audio file", JSON.stringify(summary.dubAudioPath));
		if (!summary.voice) fail("tts-summary.voice", "non-empty voice", JSON.stringify(summary.voice));
		if (summary.voice && !supportedVoices.includes(summary.voice)) fail("tts-summary.voice supported", supportedVoices.join("|"), JSON.stringify(summary.voice));
		if (taskInput.voice && summary.voice !== taskInput.voice) fail("tts-summary.voice matches input", taskInput.voice, JSON.stringify(summary.voice));
		if (Array.isArray(cues) && Number(summary.cueCount) !== cues.length) fail("tts-summary.cueCount", String(cues.length), String(summary.cueCount));
		if (!Number.isFinite(Number(summary.speechGroupCount)) || Number(summary.speechGroupCount) <= 0) {
			fail("tts-summary.speechGroupCount", "> 0", String(summary.speechGroupCount));
		}
		if (Array.isArray(cues) && Number(summary.speechGroupCount) !== cues.length) {
			fail("tts-summary.speechGroupCount matches cue count", String(cues.length), String(summary.speechGroupCount));
		}
		checkSegmentCount(segmentDir, summary);
	}
}

if (failures.length > 0) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
process.exit(0);
