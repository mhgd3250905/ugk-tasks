import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	atempoFilters,
	baseUrlForApiKey,
	buildSpeechGroups,
	hasCjk,
	isReusableTtsSegment,
	normalizeMimoVoice,
	parseCliArgs,
	parseSubtitleText,
	runConcurrent,
	segmentFitPlan,
	SUPPORTED_MIMO_VOICE_IDS,
} from "./subtitle-to-speech.mjs";

test("parses srt and vtt subtitles", () => {
	const srt = parseSubtitleText(`1
00:00:01,000 --> 00:00:02,000
你好

2
00:00:03,500 --> 00:00:04,000
世界
`);
	assert.equal(srt.length, 2);
	assert.equal(srt[0].startMs, 1000);
	assert.equal(srt[1].endMs, 4000);

	const vtt = parseSubtitleText(`WEBVTT

00:00:01.000 --> 00:00:02.500 align:start
<c>你好</c>
`);
	assert.deepEqual(vtt, [{ index: 1, startMs: 1000, endMs: 2500, text: "你好" }]);
});

test("keeps one tts group per subtitle cue so speech matches displayed subtitles", () => {
	const groups = buildSpeechGroups([
		{ index: 1, startMs: 0, endMs: 1000, text: "第一句" },
		{ index: 2, startMs: 1200, endMs: 2200, text: "第二句" },
		{ index: 3, startMs: 4000, endMs: 5000, text: "第三句" },
	], { maxChars: 20 });

	assert.equal(groups.length, 3);
	assert.equal(groups[0].text, "第一句");
	assert.deepEqual(groups[0].cueIndexes, [1]);
	assert.deepEqual(groups[1].cueIndexes, [2]);
	assert.deepEqual(groups[2].cueIndexes, [3]);
});

test("rejects invalid maxChars before grouping", () => {
	const cues = [{ index: 1, startMs: 0, endMs: 1000, text: "第一句" }];
	assert.throws(() => buildSpeechGroups(cues, { maxChars: 0 }), /maxChars must be a positive number/);
	assert.throws(() => buildSpeechGroups(cues, { maxChars: Number.NaN }), /maxChars must be a positive number/);
});

test("maps mimo api keys and detects Chinese", () => {
	assert.equal(baseUrlForApiKey("sk-abc"), "https://api.xiaomimimo.com/v1");
	assert.equal(baseUrlForApiKey("tp-abc"), "https://token-plan-cn.xiaomimimo.com/v1");
	assert.throws(() => baseUrlForApiKey("bad"), /MIMO_API_KEY/);
	assert.equal(hasCjk("中文"), true);
	assert.equal(hasCjk("plain"), false);
});

test("validates mimo preset voices before calling tts", () => {
	assert.deepEqual(SUPPORTED_MIMO_VOICE_IDS, ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]);
	assert.equal(normalizeMimoVoice("苏打"), "苏打");
	assert.throws(() => normalizeMimoVoice("活力男声"), /Unsupported MiMo voice/);
});

test("builds atempo filters for large speedups", () => {
	assert.deepEqual(atempoFilters(1), []);
	assert.deepEqual(atempoFilters(2.5), ["atempo=2.000", "atempo=1.250"]);
});

test("does not slow short speech down to fill a long subtitle window", () => {
	assert.deepEqual(segmentFitPlan(10, 30), { silence: false, speed: 1, outputSeconds: 10 });
	assert.deepEqual(segmentFitPlan(30, 10), { silence: false, speed: 3, outputSeconds: 10 });
});

test("parses cli args", () => {
	assert.deepEqual(parseCliArgs([
		"--preflight",
		"--subtitle", "zh.srt",
		"--output-dir", "out",
		"--voice", "冰糖",
		"--style-prompt", "自然",
		"--max-chars", "80",
	]), {
		preflight: true,
		subtitlePath: "zh.srt",
		outputDir: "out",
		voice: "冰糖",
		stylePrompt: "自然",
		maxChars: 80,
	});
});

test("tts segment cache is reusable only when metadata matches", () => {
	const expected = { text: "你好", voice: "冰糖", stylePrompt: "自然", startMs: 1, endMs: 2 };
	assert.equal(isReusableTtsSegment(JSON.stringify(expected), expected), true);
	assert.equal(isReusableTtsSegment(JSON.stringify({ ...expected, text: "世界" }), expected), false);
	assert.equal(isReusableTtsSegment("", expected), false);
});

test("verify rejects silent dub audio", () => {
	const outputDir = mkdtempSync(path.join(tmpdir(), "tts-verify-"));
	try {
		const dubPath = path.join(outputDir, "dub.zh.wav");
		writeFileSync(path.join(outputDir, "source.cues.json"), JSON.stringify([{ index: 1, startMs: 0, endMs: 1000, text: "你好" }]), "utf8");
		mkdirSync(path.join(outputDir, "tts-segments"));
		execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", dubPath], { stdio: "ignore" });
		writeFileSync(path.join(outputDir, "tts-summary.json"), JSON.stringify({
			subtitlePath: "source.srt",
			dubAudioPath: dubPath,
			voice: "冰糖",
			cueCount: 1,
			speechGroupCount: 1,
		}), "utf8");
		const here = path.dirname(fileURLToPath(import.meta.url));
		assert.throws(() => execFileSync(process.execPath, [path.resolve(here, "../verify.mjs")], {
			encoding: "utf8",
			env: { ...process.env, TASK_OUTPUT_DIR: outputDir, TASK_INPUT: JSON.stringify({ voice: "冰糖" }) },
		}), (error) => {
			assert.match(String(error.stdout), /dub\.zh\.wav non-silent/);
			return true;
		});
	} finally {
		if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
	}
});

test("verify rejects missing tts segment files", () => {
	const outputDir = mkdtempSync(path.join(tmpdir(), "tts-verify-"));
	try {
		const dubPath = path.join(outputDir, "dub.zh.wav");
		writeFileSync(path.join(outputDir, "source.cues.json"), JSON.stringify([{ index: 1, startMs: 0, endMs: 1000, text: "你好" }]), "utf8");
		mkdirSync(path.join(outputDir, "tts-segments"));
		execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "1", dubPath], { stdio: "ignore" });
		writeFileSync(path.join(outputDir, "tts-summary.json"), JSON.stringify({
			subtitlePath: "source.srt",
			dubAudioPath: dubPath,
			voice: "冰糖",
			cueCount: 1,
			speechGroupCount: 1,
		}), "utf8");
		const here = path.dirname(fileURLToPath(import.meta.url));
		assert.throws(() => execFileSync(process.execPath, [path.resolve(here, "../verify.mjs")], {
			encoding: "utf8",
			env: { ...process.env, TASK_OUTPUT_DIR: outputDir, TASK_INPUT: JSON.stringify({ voice: "冰糖" }) },
		}), (error) => {
			assert.match(String(error.stdout), /tts-segments fit count/);
			return true;
		});
	} finally {
		if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
	}
});

// ============================================================
// 毛病2修复:cleanSubtitleText 去音效标记(通过 parseSubtitleText 间接测)
// 原本完全不去标记,[Music]/♪♪♪ 会被 TTS 念出来
// ============================================================
test("毛病2: 解析时清除括号音效标记(不喂给 TTS)", () => {
	const srt = `1
00:00:01,000 --> 00:00:03,000
[Music] 你好世界`;
	const cues = parseSubtitleText(srt);
	assert.equal(cues[0].text, "你好世界"); // [Music] 清掉,只留对白
});

test("毛病2: 解析时清除音符符号(♪♫🎵)", () => {
	const srt = `1
00:00:01,000 --> 00:00:03,000
♪♪♪ 欢迎回来`;
	const cues = parseSubtitleText(srt);
	assert.equal(cues[0].text, "欢迎回来");
});

test("毛病2: 纯标记 cue 清洗后为空被丢弃(不调 TTS)", () => {
	// 整条都是 [Music],清洗后空 → 不进 cues → 不会拿空串调 TTS
	const srt = `1
00:00:01,000 --> 00:00:03,000
[Music]

2
00:00:04,000 --> 00:00:06,000
真实对白`;
	const cues = parseSubtitleText(srt);
	assert.equal(cues.length, 1);
	assert.equal(cues[0].text, "真实对白");
});

// ============================================================
// atempo 变速范围保护(毛病1相关:变速不会超 ffmpeg 有效范围)
// ============================================================
test("atempoFilters: 超范围自动拆段(每段在 0.5-2.0 有效区间)", () => {
	// speed=8 需要拆成多段 atempo=2.0
	const filters = atempoFilters(8);
	assert.ok(filters.length >= 3, `speed=8 应拆多段,实际 ${filters.length}`);
	// 每段都在 [0.5, 2.0]
	for (const f of filters) {
		const v = Number(f.replace("atempo=", ""));
		assert.ok(v >= 0.5 && v <= 2.0, `atempo=${v} 超出有效范围`);
	}
});

test("atempoFilters: speed=1 不加滤镜(原速)", () => {
	assert.equal(atempoFilters(1).length, 0);
});

test("segmentFitPlan: speed 上限 4(超长对白塞短窗口截断)", () => {
	// TTS 生成 10s,字幕窗口 2s → 需要 5x,但截到 4x
	const plan = segmentFitPlan(10, 2);
	assert.equal(plan.speed, 4);
});

test("segmentFitPlan: duration<=0 走静音分支(防 NaN)", () => {
	const plan = segmentFitPlan(0, 5);
	assert.equal(plan.silence, true);
});

// === runConcurrent 并发池 ===
// ponytail: 配音合成并发化的基础原语。三项硬保证:结果顺序=输入顺序、并发度不超 N、
// 单项失败不阻塞其他项。这些是"配音不能乱序 + 限流不顶满 + 单段失败不影响全局"的底线。

test("runConcurrent: 结果顺序 = 输入顺序,即使 worker 完成顺序乱", async () => {
	// 让后面的项先完成(延迟递减),验证结果仍按 index 排列。
	const items = [10, 20, 30, 40];
	const worker = async (item, index) => {
		await new Promise((r) => setTimeout(r, 40 - index * 8)); // index=0 最慢,index=3 最快
		return item * 2;
	};
	const results = await runConcurrent(items, worker, 4);
	assert.deepEqual(results.map((r) => r.value), [20, 40, 60, 80]);
	assert.ok(results.every((r) => r.ok), "全部应成功");
});

test("runConcurrent: 并发度不超过 N(高峰期 in-flight <= concurrency)", async () => {
	let inFlight = 0;
	let peak = 0;
	const items = Array.from({ length: 10 }, (_, i) => i);
	const worker = async () => {
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		await new Promise((r) => setTimeout(r, 10));
		inFlight -= 1;
	};
	await runConcurrent(items, worker, 3);
	assert.ok(peak <= 3, `并发峰值 ${peak} 超过限制 3`);
	assert.ok(peak >= 2, `并发峰值 ${peak} 过低,可能没真正并发`);
});

test("runConcurrent: 单项失败不阻塞其他项,错误收集到对应位置", async () => {
	const items = ["a", "bad", "c"];
	const worker = async (item) => {
		if (item === "bad") throw new Error("boom");
		return item.toUpperCase();
	};
	const results = await runConcurrent(items, worker, 3);
	assert.equal(results[0].ok, true);
	assert.equal(results[0].value, "A");
	assert.equal(results[1].ok, false);
	assert.match(results[1].error.message, /boom/);
	assert.equal(results[2].ok, true);
	assert.equal(results[2].value, "C");
});

test("runConcurrent: items 少于并发度时不浪费 runner", async () => {
	// 2 个 item,concurrency=10 → 只该起 2 个 runner,不报错不浪费。
	const items = [1, 2];
	const results = await runConcurrent(items, async (x) => x + 1, 10);
	assert.deepEqual(results.map((r) => r.value), [2, 3]);
});

