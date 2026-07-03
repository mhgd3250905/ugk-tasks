import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	DEFAULT_MODEL,
	DEFAULT_MODEL_DIR,
	buildExtractAudioArgs,
	buildWhisperArgs,
	buildWhisperEnv,
	copyIfExists,
	cleanWhisperTranscriptText,
	cleanWhisperTranscriptionJson,
	hasMeaningfulTranscript,
	isSupportedAudio,
	normalizeLanguage,
	parseCliArgs,
	resolveInput,
	transcriptBaseName,
} from "./whisper-audio-to-text.mjs";

test("detects supported audio extensions", () => {
	assert.equal(isSupportedAudio("a.wav"), true);
	assert.equal(isSupportedAudio("a.MP3"), true);
	assert.equal(isSupportedAudio("a.flac"), true);
	assert.equal(isSupportedAudio("a.mp4"), false);
});

test("builds ffmpeg audio extraction args", () => {
	assert.deepEqual(buildExtractAudioArgs("input.mp4", "out.wav"), [
		"-y",
		"-hide_banner",
		"-loglevel", "error",
		"-i", "input.mp4",
		"-vn",
		"-acodec", "pcm_s16le",
		"-ar", "16000",
		"-ac", "1",
		"out.wav",
	]);
});

test("builds whisper turbo args using E drive model cache", () => {
	const args = buildWhisperArgs({
		audioPath: "audio.wav",
		outputDir: "out",
		model: DEFAULT_MODEL,
		modelDir: DEFAULT_MODEL_DIR,
		language: "ru",
		task: "transcribe",
	});

	assert.deepEqual(args, [
		"audio.wav",
		"--model", "large-v3-turbo",
		"--model_dir", "E:\\AII\\.cache\\whisper",
		"--output_dir", "out",
		"--output_format", "all",
		"--task", "transcribe",
		"--language", "ru",
	]);
});

test("omits language for auto detection", () => {
	const args = buildWhisperArgs({
		audioPath: "audio.wav",
		outputDir: "out",
		model: DEFAULT_MODEL,
		modelDir: DEFAULT_MODEL_DIR,
		task: "transcribe",
	});

	assert.equal(args.includes("--language"), false);
});

test("forces utf-8 for whisper subprocess on Windows", () => {
	const env = buildWhisperEnv({ PATH: "x" });
	assert.equal(env.PYTHONUTF8, "1");
	assert.equal(env.PYTHONIOENCODING, "utf-8");
	assert.equal(env.PATH, "x");
});

test("parses both new and legacy input names", () => {
	assert.deepEqual(parseCliArgs([
		"--file-path", "video.mp4",
		"--output-dir", "out",
		"--language", "ru",
		"--model", "small",
	]), {
		filePath: "video.mp4",
		outputDir: "out",
		language: "ru",
		model: "small",
	});

	assert.deepEqual(parseCliArgs(["--file_path", "audio.wav"]), {
		filePath: "audio.wav",
	});
});

test("derives whisper output base name from audio path", () => {
	assert.equal(transcriptBaseName("E:\\tmp\\extracted_audio.wav"), "extracted_audio");
	assert.equal(transcriptBaseName("E:\\tmp\\voice.mp3"), "voice");
});

test("requires an explicit task output directory", () => {
	assert.throws(
		() => resolveInput(["--file-path", process.execPath], {}),
		/TASK_OUTPUT_DIR or --output-dir is required/,
	);

	const input = resolveInput(["--file-path", process.execPath], { TASK_OUTPUT_DIR: "out" });
	assert.equal(input.outputDir.endsWith("out"), true);
});

test("accepts quoted file path strings", () => {
	const input = resolveInput(["--file-path", `"${process.execPath}"`], { TASK_OUTPUT_DIR: "out" });
	assert.equal(input.filePath, path.resolve(process.execPath));
});

test("copyIfExists accepts already-normalized transcript output names", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "whisper-task-"));
	const transcriptPath = path.join(dir, "transcript.txt");
	await writeFile(transcriptPath, "ok", "utf8");

	assert.equal(await copyIfExists(transcriptPath, transcriptPath), transcriptPath);
	assert.equal(await readFile(transcriptPath, "utf8"), "ok");
});

test("removes short bracket Whisper noise markers from transcript text", () => {
	assert.equal(cleanWhisperTranscriptText("你好【环境音】世界 [Cheering]\n[Door creaks]继续"), "你好世界\n继续");
});

test("cleans transcription json text and drops empty noise-only segments", () => {
	const data = cleanWhisperTranscriptionJson({
		text: "开场【环境音】结束",
		segments: [
			{ id: 0, text: "[Door creaks]" },
			{ id: 1, text: "正常内容 [Cheering]" },
		],
	});

	assert.equal(data.text, "开场结束");
	assert.deepEqual(data.segments, [{ id: 1, text: "正常内容" }]);
});

// === 缺陷1:空转写检测 ===
// ponytail: 静音/纯噪音视频 whisper 可能产空 SRT,旧逻辑静默成功,错误延迟到 cleaner。

test("hasMeaningfulTranscript: 有 text 或非空 segments = true", () => {
	assert.equal(hasMeaningfulTranscript({ text: "hello" }), true);
	assert.equal(hasMeaningfulTranscript({ segments: [{ text: "hi" }] }), true);
	assert.equal(hasMeaningfulTranscript({ text: "开场", segments: [] }), true);
});

test("hasMeaningfulTranscript: text 空 + segments 全空/纯空白 = false(空转写)", () => {
	assert.equal(hasMeaningfulTranscript({ text: "", segments: [] }), false);
	assert.equal(hasMeaningfulTranscript({ text: "   ", segments: [{ text: "  " }] }), false);
	assert.equal(hasMeaningfulTranscript({}), false);
	assert.equal(hasMeaningfulTranscript({ segments: [{ text: "" }] }), false);
});

test("hasMeaningfulTranscript: 经 cleanWhisperTranscriptionJson 清洗后的纯音效输入 = false", () => {
	// 模拟真实场景:whisper 转出全是音效标记的内容,清洗后空了
	const cleaned = cleanWhisperTranscriptionJson({
		text: "[Cheering] [Music]",
		segments: [{ id: 0, text: "[Cheering]" }, { id: 1, text: "[Music]" }],
	});
	assert.equal(hasMeaningfulTranscript(cleaned), false, "纯音效标记清洗后应判为空转写");
});

// === 缺陷4:language 大小写归一 ===
// ponytail: whisper CLI 对语言大小写敏感,传 EN/Ru 会报错。

test("normalizeLanguage: 大写/混合归一为小写", () => {
	assert.equal(normalizeLanguage("EN"), "en");
	assert.equal(normalizeLanguage("Ru"), "ru");
	assert.equal(normalizeLanguage("JA"), "ja");
	assert.equal(normalizeLanguage("zh-CN"), "zh-cn");
	assert.equal(normalizeLanguage("PT-BR"), "pt-br");
});

test("normalizeLanguage: 空值 = 自动识别,返回 undefined", () => {
	assert.equal(normalizeLanguage(undefined), undefined);
	assert.equal(normalizeLanguage(null), undefined);
	assert.equal(normalizeLanguage(""), undefined);
	assert.equal(normalizeLanguage("  "), undefined);
});

test("normalizeLanguage: 非法格式 throw(数字/空格/超长)", () => {
	assert.throws(() => normalizeLanguage("english"), /Invalid language code/);
	assert.throws(() => normalizeLanguage("en123"), /Invalid language code/);
	assert.throws(() => normalizeLanguage("en us"), /Invalid language code/);
	assert.throws(() => normalizeLanguage("123"), /Invalid language code/);
});

test("buildWhisperArgs: 接收的 language 原样传入(归一由 resolveInput 负责)", () => {
	// buildWhisperArgs 不做归一,只负责拼参数;归一在 resolveInput 的 normalizeLanguage。
	const args = buildWhisperArgs({ audioPath: "a.wav", outputDir: "/out", language: "ru" });
	const langIdx = args.indexOf("--language");
	assert.equal(args[langIdx + 1], "ru");
});

test("resolveInput: language 大小写归一透传", async () => {
	// ponytail: resolveInput 会 requiredPath 校验文件存在,用真实临时文件。
	const dir = await mkdtemp(path.join(tmpdir(), "whisper-lang-"));
	const audioPath = path.join(dir, "audio.wav");
	await writeFile(audioPath, "fake");
	try {
		const input = resolveInput(["--file-path", audioPath, "--output-dir", dir, "--language", "EN"], { TASK_OUTPUT_DIR: dir });
		assert.equal(input.language, "en", "EN 应归一为 en");
	} finally {
		const { rm } = await import("node:fs/promises");
		await rm(dir, { recursive: true, force: true });
	}
});

// === 缺陷5:parseCliArgs 未知 flag throw ===
// ponytail: 与 subtitle-cleaner 行为一致,用户拼错 flag 不再静默忽略。

test("parseCliArgs: 已知 flag 正常解析(--file-path 和 --file_path 等价)", () => {
	const a = parseCliArgs(["--file-path", "/a.wav", "--output-dir", "/out"]);
	assert.equal(a.filePath, "/a.wav");
	assert.equal(a.outputDir, "/out");
	const b = parseCliArgs(["--file_path", "/b.wav"]);
	assert.equal(b.filePath, "/b.wav");
});

test("parseCliArgs: 未知 flag throw(不再静默跳过)", () => {
	assert.throws(
		() => parseCliArgs(["--langauge", "en"]),  // 故意拼错
		/Unknown flag: --langauge/,
	);
	assert.throws(
		() => parseCliArgs(["--foobar", "x"]),
		/Unknown flag: --foobar/,
	);
});

test("parseCliArgs: 已知 flag 全集都能解析", () => {
	const parsed = parseCliArgs([
		"--file-path", "/a.wav",
		"--output-dir", "/out",
		"--model", "tiny",
		"--model-dir", "/models",
		"--language", "ja",
		"--task", "translate",
	]);
	assert.equal(parsed.filePath, "/a.wav");
	assert.equal(parsed.outputDir, "/out");
	assert.equal(parsed.model, "tiny");
	assert.equal(parsed.modelDir, "/models");
	assert.equal(parsed.language, "ja");
	assert.equal(parsed.task, "translate");
});
