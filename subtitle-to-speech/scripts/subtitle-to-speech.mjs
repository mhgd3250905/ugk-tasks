import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assessSubtitleQuality } from "./subtitle-quality.mjs";

const DEFAULT_STYLE_PROMPT = "用自然、清晰、适合视频解说的中文语气，语速稳定，不要读出字幕序号或时间码。";
export const SUPPORTED_MIMO_VOICE_IDS = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];

// ponytail 毛病2修复:to-speech 的 cleanSubtitleText 原本完全不去音效标记,
// 导致 [Music]/♪♪♪ 被 TTS 念成"左方括号 Music..."。这里补上括号标记 + 音符符号清洗。
// (subtitle-quality.mjs 自带 stripSubtitleMarkers 只用于 hasSpeech 判定,喂 TTS 的文本走这里)
const BRACKET_CLOSE_BY_OPEN = { "【": "】", "[": "]", "(": ")", "（": "）" };
const SHORT_BRACKET_MARKER_RE = /([【\[\(（])\s*([^【】\[\]\(\)（）\r\n]{1,24})\s*([】\]\)）])/g;
const MUSIC_SYMBOL_RE = /[\u2669\u266A\u266B\u266C\u266D\u266E\u266F\u{1F3B5}\u{1F39A}\u{1F3B6}\u{1F3A4}\u{1F3A5}]/gu;

function isShortBracketMarker(open, inner, close) {
	const marker = String(inner || "").trim();
	if (BRACKET_CLOSE_BY_OPEN[open] !== close) return false;
	if (!marker) return true;
	if (/[0-9]/.test(marker)) return false;
	if (/[.!?。！？,，、:：;；]/.test(marker)) return false;
	return /[A-Za-z\u3400-\u9fff]/.test(marker);
}

function cleanSubtitleText(text) {
	return String(text || "")
		.replace(/<[^>]+>/g, "")
		.replace(SHORT_BRACKET_MARKER_RE, (match, open, inner, close) => (
			isShortBracketMarker(open, inner, close) ? "" : match
		))
		.replace(MUSIC_SYMBOL_RE, "")
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
	return { startMs: parseTimecode(startRaw), endMs: parseTimecode(endRaw) };
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
		if (cueText && timing.endMs > timing.startMs) {
			cues.push({ index: cues.length + 1, startMs: timing.startMs, endMs: timing.endMs, text: cueText });
		}
	}
	if (cues.length === 0) throw new Error("No subtitle cues found");
	return cues;
}

export function hasCjk(text) {
	return /[\u3400-\u9fff]/u.test(String(text || ""));
}

export function normalizeMimoVoice(value = "冰糖") {
	const voice = String(value || "冰糖").trim();
	if (SUPPORTED_MIMO_VOICE_IDS.includes(voice)) return voice;
	throw new Error(`Unsupported MiMo voice: ${voice}. Use one of: ${SUPPORTED_MIMO_VOICE_IDS.join(", ")}. voice must be an exact preset ID; put speaking style in stylePrompt.`);
}

export function buildSpeechGroups(cues, options = {}) {
	numericOption(options.maxChars, 120, "maxChars");
	return cues.map((cue, index) => ({
		index: index + 1,
		startMs: cue.startMs,
		endMs: cue.endMs,
		text: cue.text,
		cueIndexes: [cue.index],
	}));
}

function numericOption(value, fallback, name) {
	const number = value === undefined || value === "" ? fallback : Number(value);
	if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
	return number;
}

export function baseUrlForApiKey(apiKey) {
	const key = String(apiKey || "");
	if (key.startsWith("sk-")) return "https://api.xiaomimimo.com/v1";
	if (key.startsWith("tp-")) return "https://token-plan-cn.xiaomimimo.com/v1";
	throw new Error("MIMO_API_KEY must start with sk- or tp-");
}

export function atempoFilters(factor) {
	const filters = [];
	let value = Number(factor);
	while (value > 2) {
		filters.push("atempo=2.000");
		value /= 2;
	}
	while (value < 0.5) {
		filters.push("atempo=0.500");
		value /= 0.5;
	}
	filters.push(`atempo=${value.toFixed(3)}`);
	return filters.filter((filter) => filter !== "atempo=1.000");
}

export function segmentFitPlan(duration, targetSeconds) {
	if (duration <= 0 || targetSeconds <= 0) return { silence: true, speed: 1, outputSeconds: Math.max(targetSeconds, 0.1) };
	if (duration <= targetSeconds) return { silence: false, speed: 1, outputSeconds: duration };
	return { silence: false, speed: Math.min(duration / targetSeconds, 4), outputSeconds: targetSeconds };
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
			case "--voice":
				out.voice = value;
				break;
			case "--style-prompt":
				out.stylePrompt = value;
				break;
			case "--max-chars":
				out.maxChars = Number(value);
				break;
			default:
				throw new Error(`Unknown flag: ${arg}`);
		}
	}
	return out;
}

function ttsSegmentMeta(group, input) {
	return { text: group.text, voice: input.voice, stylePrompt: input.stylePrompt, startMs: group.startMs, endMs: group.endMs };
}

export function isReusableTtsSegment(metaText, expected) {
	try {
		const meta = JSON.parse(metaText || "{}");
		return meta.text === expected.text
			&& meta.voice === expected.voice
			&& meta.stylePrompt === expected.stylePrompt
			&& meta.startMs === expected.startMs
			&& meta.endMs === expected.endMs;
	} catch {
		return false;
	}
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

async function ffprobeDuration(filePath) {
	const result = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", filePath]);
	const duration = Number(result.stdout.trim());
	if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid audio duration for ${filePath}`);
	return duration;
}

function concatFileLine(filePath) {
	return `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

// ponytail 毛病1修复:TTS 调用原本无超时/无重试/无降级,单段失败全盘崩。
// 加 30s 超时 + 最多 3 次尝试(间隔递增 1s/2s/4s)。限流(429)/5xx/网络抖动可自愈。
const TTS_TIMEOUT_MS = 30000;
const TTS_MAX_ATTEMPTS = 3;

async function callMimoTtsOnce(text, { apiKey, voice, stylePrompt }) {
	const response = await fetch(`${baseUrlForApiKey(apiKey)}/chat/completions`, {
		method: "POST",
		headers: { "api-key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "mimo-v2.5-tts",
			messages: [
				{ role: "user", content: stylePrompt || DEFAULT_STYLE_PROMPT },
				{ role: "assistant", content: text },
			],
			audio: { format: "wav", voice },
		}),
		signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
	});
	const raw = await response.text();
	let body;
	try {
		body = JSON.parse(raw);
	} catch {
		body = {};
	}
	if (!response.ok) throw new Error(`MiMo TTS HTTP ${response.status}: ${body?.error?.message || raw.slice(0, 500)}`);
	const audioData = body?.choices?.[0]?.message?.audio?.data;
	if (!audioData) throw new Error("MiMo TTS response did not include audio.data");
	return Buffer.from(audioData, "base64");
}

async function callMimoTts(text, options) {
	let lastError;
	for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt += 1) {
		try {
			return await callMimoTtsOnce(text, options);
		} catch (error) {
			lastError = error;
			// 4xx(非429)是请求本身的问题(如参数错),重试无意义,直接抛
			const msg = String(error?.message || "");
			if (/HTTP 4\d\d/.test(msg) && !/HTTP 429/.test(msg)) throw error;
			if (attempt < TTS_MAX_ATTEMPTS) {
				const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s
				console.log(`[tts] attempt ${attempt}/${TTS_MAX_ATTEMPTS} failed (${msg.slice(0, 80)}), retrying in ${delayMs}ms...`);
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
		}
	}
	throw lastError;
}

async function makeSilence(filePath, seconds) {
	await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", seconds.toFixed(3), "-ar", "24000", "-ac", "1", filePath]);
}

async function fitSegment(inputPath, outputPath, targetSeconds) {
	const duration = await ffprobeDuration(inputPath);
	const plan = segmentFitPlan(duration, targetSeconds);
	if (plan.silence) {
		await makeSilence(outputPath, plan.outputSeconds);
		return plan.outputSeconds;
	}
	const filters = atempoFilters(plan.speed).join(",");
	const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath];
	if (filters) args.push("-filter:a", filters);
	if (duration > targetSeconds) args.push("-t", targetSeconds.toFixed(3));
	args.push("-ar", "24000", "-ac", "1", outputPath);
	await run("ffmpeg", args);
	return plan.outputSeconds;
}

// ponytail: 通用并发池。逐项调度,维持 N 个 in-flight,完成一个补一个。
// 结果按原 index 顺序返回(不因完成顺序乱序)——配音拼接必须按 cue 顺序,不能乱。
// 单项 worker 抛错不阻塞其他项:错误对象放进结果对应位置,由调用方决定如何处理。
// 抽成纯函数(只依赖 items/worker/concurrency)便于单测,不依赖网络/ffmpeg。
export async function runConcurrent(items, worker, concurrency = 6) {
	const limit = Math.max(1, Number(concurrency) || 1);
	const results = new Array(items.length);
	let next = 0;
	let done = 0;
	async function runOne() {
		while (next < items.length) {
			const index = next;
			next += 1;
			try {
				results[index] = { ok: true, value: await worker(items[index], index) };
			} catch (error) {
				results[index] = { ok: false, error };
			}
			done += 1;
		}
	}
	const runners = Array.from({ length: Math.min(limit, items.length) }, () => runOne());
	await Promise.all(runners);
	return results;
}

async function synthesizeDubTrack(groups, input) {
	const segmentDir = path.join(input.outputDir, "tts-segments");
	await mkdir(segmentDir, { recursive: true });

	// ponytail: 单段合成(缓存检查 → TTS 带重试 → fitSegment),自洽不依赖其他段。
	// 抽出来是为了并发化:runConcurrent 同时跑 N 段,顺序由 index 保证。
	// 返回 fitPath + segmentSeconds(供后续顺序遍历算静音填充)。
	async function synthesizeSegment(group, index) {
		const total = groups.length;
		const rawPath = path.join(segmentDir, `${String(index + 1).padStart(4, "0")}-raw.wav`);
		const fitPath = path.join(segmentDir, `${String(index + 1).padStart(4, "0")}-fit.wav`);
		const metaPath = path.join(segmentDir, `${String(index + 1).padStart(4, "0")}.json`);
		const expectedMeta = ttsSegmentMeta(group, input);
		// ponytail 毛病3修复:缓存判定要校验 raw.wav 是否有效可解析,损坏则重新生成。
		let cacheValid = false;
		if (existsSync(rawPath) && existsSync(metaPath) && isReusableTtsSegment(readFileSync(metaPath, "utf8"), expectedMeta)) {
			try {
				await ffprobeDuration(rawPath);
				cacheValid = true;
			} catch {
				console.log(`[tts] ${index + 1}/${total} cached raw.wav corrupted, regenerating`);
			}
		}
		if (!cacheValid) {
			// ponytail 毛病1修复:TTS 重试耗尽后降级填静音,不中断整个配音。
			try {
				await writeFile(rawPath, await callMimoTts(group.text, input));
				await writeFile(metaPath, JSON.stringify(expectedMeta, null, 2), "utf8");
			} catch (error) {
				console.log(`[tts] ${index + 1}/${total} FAILED after retries, filling silence: ${String(error?.message || error).slice(0, 100)}`);
				await makeSilence(rawPath, Math.max((group.endMs - group.startMs) / 1000, 0.1));
				await writeFile(metaPath, JSON.stringify({ ...expectedMeta, fallback: "silence", error: String(error?.message || error).slice(0, 200) }, null, 2), "utf8");
			}
		}
		const segmentSeconds = await fitSegment(rawPath, fitPath, Math.max((group.endMs - group.startMs) / 1000, 0.1));
		const percent = Math.round(((index + 1) / total) * 100);
		console.log(`[tts] ${index + 1}/${total} ${percent}% voice=${input.voice} chars=${group.text.length}`);
		return { fitPath, segmentSeconds };
	}

	// ponytail: 并发合成所有段(默认 6 路,TTS_CONCURRENCY 可覆盖)。
	// RPM=100 的限流下,6 路并发对 200+ cue 的视频请求阶段提速约 5-6 倍。
	// 结果按 index 顺序返回(配音顺序不会乱);单段失败已在 synthesizeSegment 内降级为静音,
	// 不会抛到这里,这里不会因单段失败而中断。
	const concurrency = Number(process.env.TTS_CONCURRENCY) || 6;
	const segmentResults = await runConcurrent(groups, synthesizeSegment, concurrency);

	// ponytail: 静音填充必须按顺序算 —— 前置静音时长依赖上一段的实际结束时间(cursorMs)。
	// 把并发合成和顺序拼接分离:并发只管拿音频,顺序遍历只管算间隙和拼 concat。
	const concatLines = [];
	let cursorMs = 0;
	async function addSilence(filePath, seconds) {
		const safeSeconds = Math.max(seconds, 0);
		if (safeSeconds <= 0) return;
		await makeSilence(filePath, safeSeconds);
		concatLines.push(concatFileLine(filePath));
	}
	for (let index = 0; index < groups.length; index += 1) {
		const group = groups[index];
		const result = segmentResults[index];
		if (!result.ok) {
			// 理论上不会到这(synthesizeSegment 内部已降级),防御性抛出。
			throw result.error;
		}
		if (group.startMs > cursorMs) {
			const silencePath = path.join(segmentDir, `${String(index).padStart(4, "0")}-gap.wav`);
			await addSilence(silencePath, (group.startMs - cursorMs) / 1000);
		}
		concatLines.push(concatFileLine(result.value.fitPath));
		cursorMs = Math.min(group.endMs, group.startMs + Math.round(result.value.segmentSeconds * 1000));
	}
	if (groups.length > 0 && groups[groups.length - 1].endMs > cursorMs) {
		await addSilence(path.join(segmentDir, "tail-gap.wav"), (groups[groups.length - 1].endMs - cursorMs) / 1000);
	}
	const concatPath = path.join(input.outputDir, "audio-concat.txt");
	await writeFile(concatPath, `${concatLines.join("\n")}\n`, "utf8");
	const dubPath = path.join(input.outputDir, "dub.zh.wav");
	await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concatPath, "-ar", "24000", "-ac", "1", dubPath]);
	return dubPath;
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
	const apiKey = env.MIMO_API_KEY;
	if (!apiKey) throw new Error("MIMO_API_KEY is missing. Set it before starting UGK. Do not put the key in task input.");
	return {
		preflight: Boolean(cli.preflight),
		subtitlePath: requiredPath(cli.subtitlePath || taskInput.subtitlePath, "subtitlePath"),
		outputDir,
		apiKey,
		voice: normalizeMimoVoice(cli.voice || taskInput.voice || "冰糖"),
		stylePrompt: String(cli.stylePrompt || taskInput.stylePrompt || DEFAULT_STYLE_PROMPT),
		maxChars: numericOption(cli.maxChars ?? taskInput.maxChars, 120, "maxChars"),
	};
}

async function main() {
	const input = resolveInput();
	await mkdir(input.outputDir, { recursive: true });
	await requireCommand("ffmpeg", ["-version"]);
	await requireCommand("ffprobe", ["-version"]);
	baseUrlForApiKey(input.apiKey);
	const cues = parseSubtitleText(readFileSync(input.subtitlePath, "utf8"));
	if (!hasCjk(cues.map((cue) => cue.text).join("\n"))) throw new Error("subtitlePath must contain Chinese text for Chinese TTS");

	// ponytail: 输入质量门禁。脏字幕直接喂 TTS 会产出垃圾配音,直接 throw 打回。
	// 错误信息只描述"需要什么质量的字幕",不指定用什么工具(用户可能没装清洗工具)。
	const quality = assessSubtitleQuality(cues);
	if (quality.verdict === "reject") {
		throw new Error(`input subtitle quality rejected: ${quality.reason}`);
	}

	await writeFile(path.join(input.outputDir, "source.cues.json"), JSON.stringify(cues, null, 2), "utf8");
	const groups = buildSpeechGroups(cues, { maxChars: input.maxChars });
	if (input.preflight) {
		console.log(JSON.stringify({ ok: true, subtitlePath: input.subtitlePath, voice: input.voice, supportedVoices: SUPPORTED_MIMO_VOICE_IDS, cueCount: cues.length, speechGroupCount: groups.length }, null, 2));
		return;
	}
	const dubPath = await synthesizeDubTrack(groups, input);
	const summary = {
		subtitlePath: input.subtitlePath,
		dubAudioPath: dubPath,
		voice: input.voice,
		maxChars: input.maxChars,
		cueCount: cues.length,
		speechGroupCount: groups.length,
	};
	await writeFile(path.join(input.outputDir, "tts-summary.json"), JSON.stringify(summary, null, 2), "utf8");
	console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
