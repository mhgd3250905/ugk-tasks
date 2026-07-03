import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assessSubtitleQuality } from "./subtitle-quality.mjs";

const DEFAULT_TARGET_LANGUAGE = "zh-CN";
const DEFAULT_MAX_UNIT_DURATION_MS = 8000;
const DEFAULT_MAX_UNIT_CHARS = 90;
const MIN_UNIT_DURATION_MS = 500;
const SPARSE_SOURCE_MAX_CHARS = 12;
const SPARSE_SOURCE_MAX_OUTPUT_CHARS = 20;
const BRACKET_CLOSE_BY_OPEN = { "【": "】", "[": "]", "(": ")", "（": "）" };
const SHORT_BRACKET_MARKER_RE = /([【\[\(（])\s*([^【】\[\]\(\)（）\r\n]{1,24})\s*([】\]\)）])/g;
// ponytail: 非括号音效符号(音符/emoji 音符)。YouTube 音乐/演唱会字幕常见,不是对白。
// 这些符号几乎不可能是正常对白内容,误伤风险极低。不碰 MUSIC:/APPLAUSE: 这类大写冒号词
// (AI:/OK: 这种对白会被误伤)。U+2669-266F=音符, U+1F3B5/1F39A/1F3B6=emoji 音符相关。
const MUSIC_SYMBOL_RE = /[\u2669\u266A\u266B\u266C\u266D\u266E\u266F\u{1F3B5}\u{1F39A}\u{1F3B6}\u{1F3A4}\u{1F3A5}]/gu;

export function defaultMaxUnitChars(verbosity = "normal") {
	return DEFAULT_MAX_UNIT_CHARS;
}

function normalizeVerbosity(value) {
	const verbosity = String(value || "normal").toLowerCase();
	if (verbosity === "normal" || verbosity === "talkative") return verbosity;
	throw new Error("verbosity must be normal or talkative");
}

function isShortBracketMarker(open, inner, close) {
	const marker = String(inner || "").trim();
	if (BRACKET_CLOSE_BY_OPEN[open] !== close) return false;
	if (!marker) return true;
	if (/[0-9]/.test(marker)) return false;
	if (/[.!?。！？,，、:：;；]/.test(marker)) return false;
	return /[A-Za-z\u3400-\u9fff]/.test(marker);
}

export function stripSubtitleMarkers(text) {
	return String(text ?? "")
		.replace(SHORT_BRACKET_MARKER_RE, (match, open, inner, close) => (
			isShortBracketMarker(open, inner, close) ? "" : match
		))
		.replace(MUSIC_SYMBOL_RE, ""); // ponytail: 也识别音符符号,让 hasSubtitleMarker 能检测
}

export function hasSubtitleMarker(text) {
	const value = String(text ?? "");
	return stripSubtitleMarkers(value) !== value;
}

function cleanSubtitleText(text) {
	return String(text || "")
		.replace(/<[^>]+>/g, "")
		.replace(SHORT_BRACKET_MARKER_RE, (match, open, inner, close) => (
			isShortBracketMarker(open, inner, close) ? "" : match
		))
		.replace(MUSIC_SYMBOL_RE, "") // ponytail: 去非括号音效符号(♪♫🎵等)
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();
}

function parseTimecode(value) {
	const normalized = String(value || "").trim().replace(",", ".");
	const [clock, fraction = "0"] = normalized.split(".");
	const parts = clock.split(":").map((part) => Number(part));
	if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
		throw new Error(`Invalid subtitle timecode: ${value}`);
	}
	const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
	return (((hours * 60 + minutes) * 60 + seconds) * 1000) + Number(fraction.padEnd(3, "0").slice(0, 3));
}

function parseTimingLine(line) {
	const match = String(line || "").match(/^\s*(\d{1,2}:)?\d{2}:\d{2}[,.]\d{3}\s*-->\s*(\d{1,2}:)?\d{2}:\d{2}[,.]\d{3}/);
	if (!match) return null;
	const [startRaw, rest] = line.split("-->");
	const endRaw = rest.trim().split(/\s+/)[0];
	return {
		startMs: parseTimecode(startRaw),
		endMs: parseTimecode(endRaw),
	};
}

export function parseSubtitleText(text) {
	const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
	const cues = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line || line === "WEBVTT" || line.startsWith("NOTE")) continue;

		let timing = parseTimingLine(line);
		if (!timing && lines[index + 1]) {
			timing = parseTimingLine(lines[index + 1]);
			if (timing) index += 1;
		}
		if (!timing) continue;

		const textLines = [];
		index += 1;
		while (index < lines.length && lines[index].trim()) {
			textLines.push(lines[index]);
			index += 1;
		}
		const cueText = cleanSubtitleText(textLines.join(" "));
		// ponytail: 区分两种情况,避免静默丢内容(Q1d 修复):
		//   - 文本为空(纯 marker 如 [Cheering] 清洗后为空)→ 静默丢弃,这是设计意图(marker 不算内容)
		//   - 文本非空但时间坏(endMs <= startMs:零时长/倒置)→ 报错拦截,不偷偷丢内容。
		//     YouTube/ASR 字幕偶有此问题;宁可失败让用户修源字幕,也不产出缺句的结果。
		if (!cueText) continue;
		if (timing.endMs <= timing.startMs) {
			throw new Error(`cue at ${formatSrtTimestamp(timing.startMs)} has invalid timing: end (${formatSrtTimestamp(timing.endMs)}) <= start; text was "${cueText.slice(0, 40)}"`);
		}
		cues.push({
			index: cues.length + 1,
			startMs: timing.startMs,
			endMs: timing.endMs,
			text: cueText,
		});
	}
	if (cues.length === 0) throw new Error("No subtitle cues found");
	return cues;
}

export function formatSrtTimestamp(ms) {
	const value = Math.max(0, Math.floor(ms));
	const hours = Math.floor(value / 3600000);
	const minutes = Math.floor((value % 3600000) / 60000);
	const seconds = Math.floor((value % 60000) / 1000);
	const millis = value % 1000;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function hasCjk(text) {
	return /[\u3400-\u9fff]/u.test(String(text || ""));
}

function normalizeUnits(data) {
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.units)) return data.units;
	if (Array.isArray(data?.items)) return data.items;
	throw new Error("fluent.units.json must be an array, or an object with units/items array");
}

function unitIds(unit) {
	const ids = unit?.ids ?? unit?.cueIds ?? unit?.sourceIds;
	if (!Array.isArray(ids) || ids.length === 0) throw new Error("unit ids must be a non-empty array");
	return ids.map((id) => {
		const value = Number(id);
		if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid cue id: ${id}`);
		return value;
	});
}

function unitText(unit) {
	return cleanSubtitleText(unit?.text ?? unit?.t ?? unit?.translation);
}

export function validateUnits(sourceCues, rawUnits, options = {}) {
	const units = normalizeUnits(rawUnits);
	const sourceById = new Map(sourceCues.map((cue) => [cue.index, cue]));
	const maxUnitDurationMs = Number(options.maxUnitDurationMs ?? DEFAULT_MAX_UNIT_DURATION_MS);
	const maxUnitChars = Number(options.maxUnitChars ?? DEFAULT_MAX_UNIT_CHARS);
	const targetLanguage = String(options.targetLanguage || DEFAULT_TARGET_LANGUAGE);
	const seen = new Set();
	let previousId = 0;
	const normalized = [];

	for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
		const ids = unitIds(units[unitIndex]);
		for (let index = 1; index < ids.length; index += 1) {
			if (ids[index] !== ids[index - 1] + 1) {
				throw new Error(`unit ${unitIndex + 1} ids must be contiguous`);
			}
		}
		for (const id of ids) {
			if (!sourceById.has(id)) throw new Error(`unknown cue id ${id}`);
			if (seen.has(id)) throw new Error(`duplicate cue id ${id}`);
			if (id <= previousId) throw new Error(`cue ids out of order at ${id}`);
			seen.add(id);
			previousId = id;
		}

		const text = unitText(units[unitIndex]);
		if (!text) throw new Error(`empty text for unit ${unitIndex + 1}`);
		if (text.length > maxUnitChars) {
			throw new Error(`unit ${unitIndex + 1} text too long: ${text.length} > ${maxUnitChars}`);
		}
		const firstCue = sourceById.get(ids[0]);
		const lastCue = sourceById.get(ids[ids.length - 1]);
		const durationMs = lastCue.endMs - firstCue.startMs;
		if (durationMs < MIN_UNIT_DURATION_MS) {
			throw new Error(`unit ${unitIndex + 1} duration too short: ${durationMs} < ${MIN_UNIT_DURATION_MS}; merge short rolling-caption cues with a neighbor`);
		}
		if (ids.length > 1 && durationMs > maxUnitDurationMs) {
			throw new Error(`unit ${unitIndex + 1} duration too long: ${durationMs} > ${maxUnitDurationMs}`);
		}
		const sourceText = ids.map((id) => sourceById.get(id).text).join(" ");
		// ponytail: cheap hallucination tripwire for bad ASR fragments; full semantic checking belongs to a reviewer model.
		if (cleanSubtitleText(sourceText).length <= SPARSE_SOURCE_MAX_CHARS && text.length > SPARSE_SOURCE_MAX_OUTPUT_CHARS) {
			throw new Error(`unit ${unitIndex + 1} source fragment too sparse for long output: ${text.length} > ${SPARSE_SOURCE_MAX_OUTPUT_CHARS}`);
		}
		normalized.push({
			ids,
			text,
			startMs: firstCue.startMs,
			endMs: lastCue.endMs,
		});
	}

	const missing = sourceCues.filter((cue) => !seen.has(cue.index)).map((cue) => cue.index);
	if (missing.length > 0) throw new Error(`missing cue ids: ${missing.join(", ")}`);
	if (targetLanguage.toLowerCase().startsWith("zh") && !normalized.some((unit) => hasCjk(unit.text))) {
		throw new Error("targetLanguage zh-CN requires CJK text");
	}
	return normalized;
}

export function buildFluentSrt(sourceCues, units, options = {}) {
	const normalized = validateUnits(sourceCues, units, options);
	// ponytail 毛病2:视频时长封顶。500ms 最小时长兜底会把尾部 endMs 往后撑,
	// 可能撑过视频时长 → verify 失败。最后一条 cue 的 endMs 不超过视频时长。
	// 注意:只在"封顶后仍 >= startMs+500"时封顶,否则保留原值(源数据矛盾,让 verify 抓,不静默产废)。
	const videoDurationSec = Number(options.videoDurationSeconds);
	const videoDurationMs = Number.isFinite(videoDurationSec) && videoDurationSec > 0 ? Math.round(videoDurationSec * 1000) : null;
	const lastIndex = normalized.length - 1;
	const lines = [];
	let prevEndMs = 0;
	for (let index = 0; index < normalized.length; index += 1) {
		const unit = normalized[index];
		// Clamp start to at least prevEndMs to enforce monotonicity.
		// Source cues may overlap by 1-2ms; the output must not.
		const startMs = Math.max(unit.startMs, prevEndMs);
		// ponytail: 保证 endMs 至少 = startMs + MIN_UNIT_DURATION_MS(500ms)。
		// 修复 Q5b:嵌套重叠(cue2 完全在 cue1 内)时,clamp startMs 上推会让 endMs<=startMs,
		// 产出零时长废 cue(播放器闪现/verify cue-count 失败)。给最小可见时长比零时长好:
		// 内容能显示,时间虽被推后但符合 verify >=500ms 约束。源时间轴本身病态时这是最不坏的兜底。
		let endMs = Math.max(unit.endMs, startMs + MIN_UNIT_DURATION_MS);
		// 最后一条 cue:用视频时长封顶(若封顶后仍满足 500ms 最小时长)
		if (index === lastIndex && videoDurationMs !== null && endMs > videoDurationMs && videoDurationMs >= startMs + MIN_UNIT_DURATION_MS) {
			endMs = videoDurationMs;
		}
		prevEndMs = endMs;
		lines.push(
			String(index + 1),
			`${formatSrtTimestamp(startMs)} --> ${formatSrtTimestamp(endMs)}`,
			unit.text,
			"",
		);
	}
	return `${lines.join("\n").trim()}\n`;
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
			case "--subtitle":
				out.subtitlePath = value;
				break;
			case "--output-dir":
				out.outputDir = value;
				break;
			case "--target-language":
				out.targetLanguage = value;
				break;
			case "--verbosity":
				out.rawVerbosity = String(value).toLowerCase();
				out.verbosity = normalizeVerbosity(value);
				break;
			case "--style-prompt":
				out.stylePrompt = value;
				break;
			case "--glossary":
				out.glossary = value;
				break;
			case "--reference-subtitle":
				out.referenceSubtitlePath = value;
				break;
			case "--video-duration-seconds":
				if (value !== "") out.videoDurationSeconds = Number(value);
				break;
			case "--max-unit-duration-ms":
				out.maxUnitDurationMs = Number(value);
				break;
			case "--max-unit-chars":
				out.maxUnitChars = Number(value);
				break;
			default:
				throw new Error(`Unknown flag: ${arg}`);
		}
	}
	return out;
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

function numericOption(value, fallback, name) {
	const number = value === undefined || value === "" ? fallback : Number(value);
	if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
	return number;
}

function resolveInput(argv = process.argv.slice(2), env = process.env) {
	const cli = parseCliArgs(argv);
	const taskInput = parseTaskInput(env);
	const outputDir = path.resolve(cli.outputDir || env.TASK_OUTPUT_DIR || taskInput.outputDir || "");
	if (!outputDir) throw new Error("TASK_OUTPUT_DIR or --output-dir is required");
	const rawVerbosity = cli.rawVerbosity || taskInput.verbosity || "normal";
	const verbosity = normalizeVerbosity(rawVerbosity);
	return {
		preflight: Boolean(cli.preflight),
		subtitlePath: requiredPath(cli.subtitlePath || taskInput.subtitlePath, "subtitlePath"),
		outputDir,
		targetLanguage: String(cli.targetLanguage || taskInput.targetLanguage || DEFAULT_TARGET_LANGUAGE),
		verbosity,
		rawVerbosity: String(rawVerbosity).toLowerCase(),
		stylePrompt: String(cli.stylePrompt || taskInput.stylePrompt || ""),
		glossary: String(cli.glossary || taskInput.glossary || ""),
		referenceSubtitlePath: cli.referenceSubtitlePath || taskInput.referenceSubtitlePath
			? requiredPath(cli.referenceSubtitlePath || taskInput.referenceSubtitlePath, "referenceSubtitlePath")
			: "",
		videoDurationSeconds: cli.videoDurationSeconds ?? taskInput.videoDurationSeconds,
		maxUnitDurationMs: numericOption(cli.maxUnitDurationMs ?? taskInput.maxUnitDurationMs, DEFAULT_MAX_UNIT_DURATION_MS, "maxUnitDurationMs"),
		maxUnitChars: numericOption(cli.maxUnitChars ?? taskInput.maxUnitChars, defaultMaxUnitChars(verbosity), "maxUnitChars"),
	};
}

async function writeSourceCues(input) {
	const sourceCues = parseSubtitleText(readFileSync(input.subtitlePath, "utf8"));
	await writeFile(path.join(input.outputDir, "source.cues.json"), JSON.stringify(sourceCues, null, 2), "utf8");
	if (input.referenceSubtitlePath) {
		const referenceCues = parseSubtitleText(readFileSync(input.referenceSubtitlePath, "utf8"));
		await writeFile(path.join(input.outputDir, "reference.cues.json"), JSON.stringify(referenceCues, null, 2), "utf8");
	}
	return sourceCues;
}

async function main() {
	const input = resolveInput();
	await mkdir(input.outputDir, { recursive: true });
	const sourceCues = await writeSourceCues(input);

	// ponytail: 输入质量门禁。task 独立,不假设上游是谁——脏字幕直接喂进来会产出垃圾。
	// 明显低质量(回声碎片过多/无对白)直接 throw 打回,不浪费 LLM 翻译时间。
	// 错误信息只描述"需要什么质量的字幕",不指定用什么工具清洗(用户可能没装清洗工具)。
	const quality = assessSubtitleQuality(sourceCues);
	if (quality.verdict === "reject") {
		throw new Error(`input subtitle quality rejected: ${quality.reason}`);
	}

	// ponytail: videoDurationSeconds 提前拦截尾部越界(毛病2 修复)。
	// Whisper/ASR 常在结尾幻听出不存在的对话,时间戳跑到视频外。
	// 但 YouTube 字幕尾部常略超视频时长(时间戳精度/结尾处理),属正常偏差,不是 bug。
	// 策略:越界 >容差(真幻听)才打回;<容差(YouTube正常偏差)放行。
	//
	// 容差依据(实测 99 个真实 YouTube 字幕样本,2026-07-02 调研):
	//   - 96/99(97%)字幕尾部越界,说明这是 YouTube 普遍行为,非我们算错
	//   - 最大越界 1.94 秒,分布集中在 0.3~1.94s
	//   - 3 秒 = 最大值的 1.5 倍,留足安全边际;真幻听(Whisper 编造结尾段落)通常 >5s
	// 别轻易改小这个值——会让 97% 的正常 YouTube 字幕被误杀。
	const VIDEO_DURATION_TOLERANCE_MS = 3000;
	const videoDurationSec = Number(input.videoDurationSeconds);
	if (Number.isFinite(videoDurationSec) && videoDurationSec > 0 && sourceCues.length > 0) {
		const videoDurationMs = Math.round(videoDurationSec * 1000);
		const lastEndMs = sourceCues[sourceCues.length - 1].endMs;
		if (lastEndMs > videoDurationMs + VIDEO_DURATION_TOLERANCE_MS) {
			throw new Error(`source subtitle tail exceeds video duration by >${VIDEO_DURATION_TOLERANCE_MS / 1000}s: last cue ends at ${formatSrtTimestamp(lastEndMs)} but video is ${formatSrtTimestamp(videoDurationMs)}; likely ASR tail hallucination, needs a subtitle ending within ~${VIDEO_DURATION_TOLERANCE_MS / 1000}s of video end`);
		}
	}

	if (input.preflight) {
		console.log(JSON.stringify({
			ok: true,
			subtitlePath: input.subtitlePath,
			targetLanguage: input.targetLanguage,
			verbosity: input.verbosity,
			sourceCueCount: sourceCues.length,
			maxUnitDurationMs: input.maxUnitDurationMs,
			maxUnitChars: input.maxUnitChars,
			glossary: input.glossary,
			referenceSubtitlePath: input.referenceSubtitlePath,
			videoDurationSeconds: input.videoDurationSeconds,
		}, null, 2));
		return;
	}

	const unitsPath = path.join(input.outputDir, "fluent.units.json");
	if (!existsSync(unitsPath)) {
		throw new Error(`fluent units are missing: ${unitsPath}`);
	}
	const units = JSON.parse(readFileSync(unitsPath, "utf8").replace(/^\uFEFF/, ""));
	const normalized = validateUnits(sourceCues, units, input);
	const outputSubtitlePath = path.join(input.outputDir, "fluent.zh.srt");
	await writeFile(outputSubtitlePath, buildFluentSrt(sourceCues, normalized, input), "utf8");
	const report = {
		sourceSubtitlePath: input.subtitlePath,
		outputSubtitlePath,
		targetLanguage: input.targetLanguage,
		verbosity: input.rawVerbosity,
		sourceCueCount: sourceCues.length,
		unitCount: normalized.length,
		maxUnitDurationMs: input.maxUnitDurationMs,
		maxUnitChars: input.maxUnitChars,
		stylePrompt: input.stylePrompt,
		glossary: input.glossary,
		referenceSubtitlePath: input.referenceSubtitlePath,
		videoDurationSeconds: input.videoDurationSeconds,
	};
	await writeFile(path.join(input.outputDir, "fluent-report.json"), JSON.stringify(report, null, 2), "utf8");
	console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
