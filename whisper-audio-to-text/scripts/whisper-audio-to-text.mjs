import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MODEL = "large-v3-turbo";
export const DEFAULT_MODEL_DIR = "E:\\AII\\.cache\\whisper";

const AUDIO_EXTENSIONS = new Set([".m4a", ".mp3", ".wav", ".flac", ".ogg"]);
const BRACKET_CLOSE_BY_OPEN = { "【": "】", "[": "]", "(": ")", "（": "）" };
const SHORT_BRACKET_MARKER_RE = /([【\[\(（])\s*([^【】\[\]\(\)（）\r\n]{1,24})\s*([】\]\)）])/g;

export function isSupportedAudio(filePath) {
	return AUDIO_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}

export function buildExtractAudioArgs(inputPath, outputPath) {
	return [
		"-y",
		"-hide_banner",
		"-loglevel", "error",
		"-i", inputPath,
		"-vn",
		"-acodec", "pcm_s16le",
		"-ar", "16000",
		"-ac", "1",
		outputPath,
	];
}

// ponytail 缺陷4修复:whisper CLI 对语言代码大小写敏感(传 EN/Ru 会报 language not found)。
// 归一为小写(whisper 接受 ISO 639-1 如 en/zh/ja/ru 及 zh-CN 变体)。空值=自动识别,放行。
export function normalizeLanguage(value) {
	if (value === undefined || value === null || value === "") return undefined;
	const normalized = String(value).trim().toLowerCase();
	if (!normalized) return undefined;
	// 允许字母 + 连字符(如 zh-cn、pt-br);拒绝数字/空格/其他符号(明显非法)
	if (!/^[a-z]{2,3}(-[a-z0-9]{2,})?$/.test(normalized)) {
		throw new Error(`Invalid language code: ${JSON.stringify(value)}. Use ISO 639-1 like en/zh/ja/ru (lowercase), or omit for auto-detect.`);
	}
	return normalized;
}

export function buildWhisperArgs(input) {
	const args = [
		input.audioPath,
		"--model", input.model || DEFAULT_MODEL,
		"--model_dir", input.modelDir || DEFAULT_MODEL_DIR,
		"--output_dir", input.outputDir,
		"--output_format", "all",
		"--task", input.task || "transcribe",
	];
	if (input.language) args.push("--language", input.language);
	return args;
}

export function buildWhisperEnv(env = process.env) {
	return {
		...env,
		PYTHONUTF8: "1",
		PYTHONIOENCODING: "utf-8",
	};
}

export function transcriptBaseName(audioPath) {
	return path.basename(audioPath, path.extname(audioPath));
}

function isShortBracketMarker(open, inner, close) {
	const marker = String(inner || "").trim();
	if (BRACKET_CLOSE_BY_OPEN[open] !== close) return false;
	if (!marker) return true;
	if (/[0-9]/.test(marker)) return false;
	if (/[.!?。！？,，、:：;；]/.test(marker)) return false;
	return /[A-Za-z\u3400-\u9fff]/.test(marker);
}

function stripWhisperNoiseMarkers(text) {
	return String(text ?? "").replace(SHORT_BRACKET_MARKER_RE, (match, open, inner, close) => (
		isShortBracketMarker(open, inner, close) ? "" : match
	)).replace(/[ \t]{2,}/g, " ");
}

export function cleanWhisperTranscriptText(text) {
	return stripWhisperNoiseMarkers(text)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.join("\n");
}

export function cleanWhisperTranscriptionJson(value) {
	const data = { ...(value || {}) };
	if (typeof data.text === "string") data.text = cleanWhisperTranscriptText(data.text);
	if (Array.isArray(data.segments)) {
		data.segments = data.segments
			.map((segment) => ({ ...segment, text: cleanWhisperTranscriptText(segment?.text) }))
			.filter((segment) => segment.text);
	}
	return data;
}

// ponytail 缺陷1修复:空转写检测。静音/纯噪音视频 whisper 可能产空 SRT,
// 但旧逻辑只 filter 掉空段不 throw,导致"静默成功",错误延迟到 cleaner 才暴露且归因错位。
// 清洗后 segments 全空且 text 也空 = 无实质内容,在此 throw,错误明确指向 whisper。
export function hasMeaningfulTranscript(cleanedJson) {
	const data = cleanedJson || {};
	const hasText = typeof data.text === "string" && data.text.trim().length > 0;
	const segments = Array.isArray(data.segments) ? data.segments : [];
	const hasSegments = segments.some((segment) => typeof segment?.text === "string" && segment.text.trim().length > 0);
	return hasText || hasSegments;
}

export function parseCliArgs(argv) {
	// ponytail 缺陷5修复:对未知 flag throw(与 subtitle-cleaner 行为一致)。
	// 旧行为静默跳过未知 flag,用户拼错 --langauge 会被忽略然后 whisper 自动识别语言,
	// 看似成功实则没用上用户指定的语言,难排查。
	const KNOWN_FLAGS = new Set(["filePath", "outputDir", "model", "modelDir", "language", "task"]);
	const values = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2).replace(/[-_]([a-z])/g, (_, char) => char.toUpperCase());
		if (!KNOWN_FLAGS.has(key)) {
			throw new Error(`Unknown flag: ${arg}. Known flags: --file-path, --output-dir, --model, --model-dir, --language, --task.`);
		}
		values[key] = argv[index + 1];
		index += 1;
	}
	return {
		...(values.filePath ? { filePath: values.filePath } : {}),
		...(values.outputDir ? { outputDir: values.outputDir } : {}),
		...(values.model ? { model: values.model } : {}),
		...(values.modelDir ? { modelDir: values.modelDir } : {}),
		...(values.language ? { language: values.language } : {}),
		...(values.task ? { task: values.task } : {}),
	};
}

async function run(command, args, options = {}) {
	const child = spawn(command, args, { windowsHide: true, env: options.env || process.env });
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
	if (exitCode !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with exit ${exitCode}:\n${stderr || stdout}`);
	}
	return { stdout, stderr };
}

function parseTaskInput(env) {
	try {
		return JSON.parse(env.TASK_INPUT || "{}");
	} catch {
		return {};
	}
}

function requiredPath(value, name) {
	const text = String(value || "").trim();
	const unquoted = /^(['"]).*\1$/.test(text) ? text.slice(1, -1) : text;
	const resolved = unquoted ? path.resolve(unquoted) : "";
	if (!resolved) throw new Error(`${name} is required`);
	if (!existsSync(resolved)) throw new Error(`${name} does not exist: ${resolved}`);
	return resolved;
}

export function resolveInput(argv = process.argv.slice(2), env = process.env) {
	const cli = parseCliArgs(argv);
	const taskInput = parseTaskInput(env);
	const outputDirValue = cli.outputDir || env.TASK_OUTPUT_DIR || taskInput.outputDir;
	if (!outputDirValue) throw new Error("TASK_OUTPUT_DIR or --output-dir is required");
	const outputDir = path.resolve(String(outputDirValue));
	const filePath = cli.filePath || taskInput.filePath || taskInput.file_path;
	const model = String(cli.model || taskInput.model || DEFAULT_MODEL);
	const modelDir = path.resolve(cli.modelDir || taskInput.modelDir || DEFAULT_MODEL_DIR);
	return {
		filePath: requiredPath(filePath, "filePath"),
		outputDir,
		model,
		modelDir,
		language: normalizeLanguage(cli.language || taskInput.language),
		task: String(cli.task || taskInput.task || "transcribe"),
	};
}

export async function copyIfExists(from, to) {
	if (!existsSync(from)) return undefined;
	if (path.resolve(from) === path.resolve(to)) return to;
	await copyFile(from, to);
	return to;
}

async function cleanGeneratedWhisperFiles(generated) {
	for (const filePath of [generated.txt, generated.srt, generated.vtt, generated.tsv]) {
		if (!existsSync(filePath)) continue;
		await writeFile(filePath, stripWhisperNoiseMarkers(await readFile(filePath, "utf8")), "utf8");
	}
	if (existsSync(generated.json)) {
		const data = JSON.parse(await readFile(generated.json, "utf8"));
		await writeFile(generated.json, `${JSON.stringify(cleanWhisperTranscriptionJson(data), null, 2)}\n`, "utf8");
	}
}

async function main() {
	const input = resolveInput();
	await mkdir(input.outputDir, { recursive: true });
	const modelPath = path.join(input.modelDir, `${input.model}.pt`);
	if (!existsSync(modelPath)) {
		throw new Error(`Whisper model is missing: ${modelPath}. Keep models on E: or pass --model-dir.`);
	}

	let audioPath = input.filePath;
	let extractedAudioPath;
	if (!isSupportedAudio(input.filePath)) {
		extractedAudioPath = path.join(input.outputDir, "extracted_audio.wav");
		await run("ffmpeg", buildExtractAudioArgs(input.filePath, extractedAudioPath), { streamStderr: true });
		audioPath = extractedAudioPath;
	}

	await run("whisper", buildWhisperArgs({ ...input, audioPath }), {
		env: buildWhisperEnv(),
		streamStdout: true,
		streamStderr: true,
	});
	const base = transcriptBaseName(audioPath);
	const generated = {
		txt: path.join(input.outputDir, `${base}.txt`),
		srt: path.join(input.outputDir, `${base}.srt`),
		vtt: path.join(input.outputDir, `${base}.vtt`),
		json: path.join(input.outputDir, `${base}.json`),
		tsv: path.join(input.outputDir, `${base}.tsv`),
	};
	await cleanGeneratedWhisperFiles(generated);
	// ponytail 缺陷1修复:清洗后检查转写是否有实质内容。空转写(静音/纯噪音视频)在此明确失败,
	// 不让错误延迟到下游 cleaner(报 No subtitle cues found,归因错位让用户去查 cleaner)。
	if (existsSync(generated.json)) {
		const cleanedJson = JSON.parse(await readFile(generated.json, "utf8"));
		if (!hasMeaningfulTranscript(cleanedJson)) {
			throw new Error("whisper produced an empty transcript (no meaningful text after cleaning). 输入可能是静音/纯噪音,或 whisper 未能识别任何语音。请检查源音视频是否有对白。");
		}
	}
	const artifacts = {
		transcriptTextPath: await copyIfExists(generated.txt, path.join(input.outputDir, "transcript.txt")),
		transcriptSrtPath: await copyIfExists(generated.srt, path.join(input.outputDir, "transcript.srt")),
		transcriptVttPath: await copyIfExists(generated.vtt, path.join(input.outputDir, "transcript.vtt")),
		transcriptionJsonPath: await copyIfExists(generated.json, path.join(input.outputDir, "transcription.json")),
		transcriptTsvPath: await copyIfExists(generated.tsv, path.join(input.outputDir, "transcript.tsv")),
	};
	if (!artifacts.transcriptTextPath || !artifacts.transcriptSrtPath || !artifacts.transcriptVttPath) {
		throw new Error("whisper finished but transcript.txt/srt/vtt were not produced");
	}
	const summary = {
		inputFilePath: input.filePath,
		audioPath,
		extractedAudioPath,
		model: input.model,
		modelDir: input.modelDir,
		language: input.language || "auto",
		task: input.task,
		...artifacts,
	};
	await writeFile(path.join(input.outputDir, "whisper-summary.json"), JSON.stringify(summary, null, 2), "utf8");
	console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
