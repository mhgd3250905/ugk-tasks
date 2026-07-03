import { strict as assert } from "node:assert";
import test from "node:test";

import {
	buildDownloadArgs,
	buildFormatSelector,
	buildMetadataArgs,
	normalizeVideoUrl,
	parseCliArgs,
	parseInput,
	resolveSubtitlePlan,
	selectTargetHeight,
} from "./download-video.mjs";

// ---------- 辅助:构造 metadata.formats ----------
function formats(...sizes) {
	// sizes: [width, height] 对
	return sizes.map(([w, h], i) => ({
		format_id: String(i),
		vcodec: "avc1",
		acodec: "none",
		width: w,
		height: h,
	}));
}

// ============================================================
// URL 规范化
// ============================================================
test("normalizes generic http and https video urls", () => {
	assert.equal(
		normalizeVideoUrl(" https://www.youtube.com/watch?v=abc123&list=skip "),
		"https://www.youtube.com/watch?v=abc123&list=skip",
	);
	assert.equal(
		normalizeVideoUrl("http://example.com/video"),
		"http://example.com/video",
	);
});

test("rejects non-http urls", () => {
	assert.throws(() => normalizeVideoUrl("file:///C:/video.mp4"), /http or https/);
	assert.throws(() => normalizeVideoUrl("not a url"), /valid video URL/);
});

// ============================================================
// selectTargetHeight — 分辨率智能选择
// ============================================================
test("selectTargetHeight: 未指定 → 档位链命中 1080(最高可用档位)", () => {
	const meta = { formats: formats([1920, 1080], [1280, 720], [640, 480]) };
	const r = selectTargetHeight(meta, undefined, false);
	assert.equal(r.target, 1080);
	assert.equal(r.source, "ladder-match");
	assert.equal(r.specified, false);
});

test("selectTargetHeight: 未指定 → 没有 1080 就 720(依次往下)", () => {
	const meta = { formats: formats([1280, 720], [640, 480], [426, 240]) };
	const r = selectTargetHeight(meta, undefined, false);
	assert.equal(r.target, 720);
	assert.equal(r.source, "ladder-match");
});

test("selectTargetHeight: 未指定 + 非标准高度 → 区间匹配命中正确档位(复刻真实 1058 case)", () => {
	// 真实视频:Bboy Menno 1920x1058,可用高度 [142,352,706,1058] 都是非标准
	// 区间匹配:1058 落在 (720,1080] → 命中 1080 档,target 取区间内最大 = 1058
	const meta = { formats: formats([1920, 1058], [1280, 706], [640, 352], [256, 142]) };
	const r = selectTargetHeight(meta, undefined, false);
	assert.equal(r.target, 1058);
	assert.equal(r.source, "ladder-match"); // 不再是 fallback-max,区间匹配正确命中
	// 如果只有中间档的非标准值
	const meta2 = { formats: formats([1280, 706], [640, 352]) };
	const r2 = selectTargetHeight(meta2, undefined, false);
	assert.equal(r2.target, 706); // 706 落在 (480,720] → 命中 720 档
	assert.equal(r2.source, "ladder-match");
});

test("selectTargetHeight: 区间匹配边界 — 高度恰好等于档位边界", () => {
	// 恰好 720 → 落在 (480,720] 命中 720 档
	const meta = { formats: formats([1280, 720], [854, 480]) };
	assert.equal(selectTargetHeight(meta, undefined, false).target, 720);
	// 恰好 481 → 落在 (480,720]? 不,481>480 且 <=720 → 命中 720 档,target=481
	const meta2 = { formats: formats([854, 481]) };
	assert.equal(selectTargetHeight(meta2, undefined, false).target, 481);
	// 恰好 480 → 落在 (360,480] 命中 480 档
	const meta3 = { formats: formats([854, 480]) };
	const r3 = selectTargetHeight(meta3, undefined, false);
	assert.equal(r3.target, 480);
});

test("selectTargetHeight: 未指定 → 档位都凑不上取可用最大", () => {
	// 1440p 不在档位链里,档位里只有 480 可用 → 命中 480
	const meta = { formats: formats([2560, 1440], [640, 480]) };
	const r = selectTargetHeight(meta, undefined, false);
	assert.equal(r.target, 480);
	assert.equal(r.source, "ladder-match");
	// 但如果完全没有档位链内的尺寸
	const meta2 = { formats: formats([2560, 1440]) };
	const r2 = selectTargetHeight(meta2, undefined, false);
	assert.equal(r2.target, 1440);
	assert.equal(r2.source, "fallback-max");
});

test("selectTargetHeight: 指定 → 选 <= N 内最大(不超)", () => {
	const meta = { formats: formats([1920, 1080], [1280, 720], [640, 480]) };
	// 指定 720 → 有 720 取 720
	assert.equal(selectTargetHeight(meta, 720, false).target, 720);
	// 指定 700 → 没有 700,取 <=700 最大 = 480
	assert.equal(selectTargetHeight(meta, 700, false).target, 480);
	// 指定 480 → 480
	assert.equal(selectTargetHeight(meta, 480, false).target, 480);
	// 指定 5000 → 都不超,取最大 1080
	assert.equal(selectTargetHeight(meta, 5000, false).target, 1080);
});

test("selectTargetHeight: 指定但无任何 <= N 的 → 取最小(守约不超)", () => {
	const meta = { formats: formats([1920, 1080], [1280, 720]) };
	// 指定 240,但最低 720 → 取 720(最小),不取 1080
	const r = selectTargetHeight(meta, 240, false);
	assert.equal(r.target, 720);
	assert.equal(r.source, "specified-cap");
	assert.equal(r.specified, true);
});

test("selectTargetHeight: 竖屏按 width 选档位", () => {
	// 竖屏 360×640,720×1280。dimKey=width → 可用 dims=[360,720]
	const meta = { formats: formats([360, 640], [720, 1280]) };
	// 未指定:档位链 1080→...→360? 档位链是 [1080,720,480,360,240,144]
	// width=720 命中档位 720
	const r = selectTargetHeight(meta, undefined, true);
	assert.equal(r.target, 720);
	assert.equal(r.source, "ladder-match");
	assert.deepEqual(r.available, [360, 720]);
});

test("selectTargetHeight: 空 formats → target undefined,回退信号", () => {
	const r1 = selectTargetHeight({ formats: [] }, undefined, false);
	assert.equal(r1.target, undefined);
	assert.equal(r1.source, "none");
	const r2 = selectTargetHeight({}, 720, false);
	assert.equal(r2.target, undefined);
	assert.equal(r2.specified, true);
});

test("selectTargetHeight: maxHeight 非法值视为未指定", () => {
	const meta = { formats: formats([1280, 720]) };
	assert.equal(selectTargetHeight(meta, "bad", false).target, 720);
	assert.equal(selectTargetHeight(meta, 0, false).target, 720);
	assert.equal(selectTargetHeight(meta, -5, false).target, 720);
	assert.equal(selectTargetHeight(meta, NaN, false).specified, false);
});

// ============================================================
// buildFormatSelector
// ============================================================
test("buildFormatSelector: 横屏目标 480", () => {
	assert.equal(buildFormatSelector(480, false), "bv*[height<=480]+ba/b[height<=480]/bv*+ba/b");
});

test("buildFormatSelector: 竖屏目标 360 → 按 width 限短边", () => {
	assert.equal(
		buildFormatSelector(360, true),
		"bv[width<=360][height<=720]+ba/b[width<=360]/bv[width<=360]+ba/bv*+ba/b",
	);
});

test("buildFormatSelector: target undefined/bad → 通用回退", () => {
	assert.equal(buildFormatSelector(undefined, false), "bv*+ba/b");
	assert.equal(buildFormatSelector("bad", false), "bv*+ba/b");
	assert.equal(buildFormatSelector(0, false), "bv*+ba/b");
});

// ============================================================
// resolveSubtitlePlan — 字幕智能选择
// ============================================================
test("resolveSubtitlePlan: 指定 → 严格用指定 + 含自动字幕", () => {
	const meta = { subtitles: { en: [], zh: [] }, automatic_captions: { en: [], ja: [] } };
	const r = resolveSubtitlePlan(meta, "ru,fr");
	assert.equal(r.langs, "ru,fr");
	assert.equal(r.includeAuto, true);
	assert.equal(r.specified, true);
	assert.equal(r.source, "specified");
});

test("resolveSubtitlePlan: 未指定 + 有人工字幕 → 下人工字幕全部语种", () => {
	const meta = { subtitles: { en: [], "zh-Hans": [], ja: [] }, automatic_captions: { en: [], fr: [], de: [], es: [] } };
	const r = resolveSubtitlePlan(meta, undefined);
	assert.equal(r.langs, "en,zh-Hans,ja");
	assert.equal(r.includeAuto, false);
	assert.equal(r.source, "manual");
	assert.equal(r.specified, false);
});

test("resolveSubtitlePlan: 未指定 + 无人工字幕 + 有视频主语言 → 优先主语言自动字幕", () => {
	// 复刻真实 case:俄语视频 language=ru,自动字幕有 ru+ru-orig+en+zh-Hans
	const meta = { language: "ru", subtitles: {}, automatic_captions: { "ru-orig": [], ru: [], en: [], "zh-Hans": [], ja: [] } };
	const r = resolveSubtitlePlan(meta, undefined);
	// base 匹配 ru → 命中 ru + ru-orig(都是俄语)
	assert.deepEqual(r.langs.split(",").sort(), ["ru", "ru-orig"].sort());
	assert.equal(r.includeAuto, true);
	assert.equal(r.source, "auto-main-lang");
	assert.equal(r.videoLanguage, "ru");
});

test("resolveSubtitlePlan: 未指定 + 有主语言但主语言无自动字幕 → 回退 en+zh", () => {
	// 主语言 ru,但自动字幕里没 ru → 回退 en+zh
	const meta = { language: "ru", subtitles: {}, automatic_captions: { en: [], "zh-Hans": [], ja: [] } };
	const r = resolveSubtitlePlan(meta, undefined);
	assert.deepEqual(r.langs.split(",").sort(), ["en", "zh-Hans"].sort());
	assert.equal(r.source, "auto-en-zh");
});

test("resolveSubtitlePlan: 未指定 + 主语言带变体(pt-PT) → base 匹配 pt*", () => {
	const meta = { language: "pt-PT", subtitles: {}, automatic_captions: { pt: [], "pt-BR": [], en: [] } };
	const r = resolveSubtitlePlan(meta, undefined);
	assert.deepEqual(r.langs.split(",").sort(), ["pt", "pt-BR"].sort());
	assert.equal(r.source, "auto-main-lang");
	assert.equal(r.videoLanguage, "pt-PT");
});

test("resolveSubtitlePlan: 无 metadata.language 字段 → 跳过主语言,直接 en+zh", () => {
	// 主语言缺失(老 meta 或平台没标),不应崩,直接走 en+zh
	const meta = { subtitles: {}, automatic_captions: { en: [], "zh-Hans": [], ja: [] } };
	const r = resolveSubtitlePlan(meta, undefined);
	assert.deepEqual(r.langs.split(",").sort(), ["en", "zh-Hans"].sort());
	assert.equal(r.source, "auto-en-zh");
	assert.equal(r.videoLanguage, null);
});

test("resolveSubtitlePlan: 未指定 + 无人工字幕 + 无主语言 → 自动字幕 en+zh 过滤", () => {
	const meta = { subtitles: {}, automatic_captions: { en: [], "zh-Hans": [], ja: [], ko: [], fr: [], de: [], es: [] } };
	const r = resolveSubtitlePlan(meta, undefined);
	// 只取 en/zh 开头
	assert.deepEqual(r.langs.split(",").sort(), ["en", "zh-Hans"].sort());
	assert.equal(r.includeAuto, true);
	assert.equal(r.source, "auto-en-zh");
});

test("resolveSubtitlePlan: 未指定 + 自动字幕只有 ja/ko → 都不要(过滤后空),不下", () => {
	const meta = { subtitles: {}, automatic_captions: { ja: [], ko: [] } };
	const r = resolveSubtitlePlan(meta, undefined);
	assert.equal(r.langs, "");
	assert.equal(r.includeAuto, false);
	assert.equal(r.source, "none");
});

test("resolveSubtitlePlan: 两者皆空 → 不下字幕", () => {
	const r1 = resolveSubtitlePlan({}, undefined);
	assert.equal(r1.langs, "");
	assert.equal(r1.source, "none");
	const r2 = resolveSubtitlePlan({ subtitles: {}, automatic_captions: {} }, undefined);
	assert.equal(r2.langs, "");
	assert.equal(r2.source, "none");
});

test("resolveSubtitlePlan: 指定空串/纯空白 → 视为未指定走自动逻辑", () => {
	const meta = { subtitles: { en: [] } };
	assert.equal(resolveSubtitlePlan(meta, "").source, "manual");
	assert.equal(resolveSubtitlePlan(meta, "   ").source, "manual");
	assert.equal(resolveSubtitlePlan(meta, undefined).source, "manual");
});

// ============================================================
// metadata args / cookies
// ============================================================
test("builds metadata args without playlist by default", () => {
	assert.deepEqual(buildMetadataArgs("https://example.com/v"), [
		"--skip-download",
		"--dump-json",
		"--no-playlist",
		"https://example.com/v",
	]);
});

test("adds browser cookies to metadata and download args when requested", () => {
	assert.deepEqual(buildMetadataArgs("https://example.com/v", { cookiesFromBrowser: "chrome" }), [
		"--cookies-from-browser",
		"chrome",
		"--skip-download",
		"--dump-json",
		"--no-playlist",
		"https://example.com/v",
	]);

	const args = buildDownloadArgs(
		{ url: "https://example.com/v", outputDir: "out", cookiesFromBrowser: "chrome" },
		{ targetHeight: 1080, isVertical: false, subtitlePlan: { langs: "en", includeAuto: false } },
	);

	assert.equal(args[0], "--cookies-from-browser");
	assert.equal(args[1], "chrome");
});

test("rejects unsupported browser cookie sources", () => {
	assert.throws(() => parseCliArgs(["--cookies-from-browser", "firefox"]), /cookiesFromBrowser must be none or chrome/);
});

// ============================================================
// buildDownloadArgs — 新签名(接受 options.targetHeight/isVertical/subtitlePlan)
// ============================================================
test("buildDownloadArgs: 有字幕时带 write-subs/sub-langs/sub-format", () => {
	const args = buildDownloadArgs(
		{ url: "https://example.com/v", outputDir: "out" },
		{ targetHeight: 720, isVertical: false, subtitlePlan: { langs: "en,zh", includeAuto: false } },
	);
	assert.ok(args.includes("--write-subs"));
	assert.ok(args.includes("--sub-langs"));
	assert.ok(args.includes("en,zh"));
	assert.ok(args.includes("--sub-format"));
	assert.ok(args.includes("vtt"));
	assert.ok(!args.includes("--write-auto-subs"), "manual subs should not enable auto-subs");
	assert.ok(args.includes("--merge-output-format"));
	assert.ok(args.includes("mp4"));
	assert.ok(args.includes("--format"));
	assert.ok(args.includes("bv*[height<=720]+ba/b[height<=720]/bv*+ba/b"));
});

test("buildDownloadArgs: includeAuto=true 时带 --write-auto-subs", () => {
	const args = buildDownloadArgs(
		{ url: "https://example.com/v", outputDir: "out" },
		{ targetHeight: 720, isVertical: false, subtitlePlan: { langs: "en", includeAuto: true } },
	);
	assert.ok(args.includes("--write-auto-subs"));
});

test("buildDownloadArgs: 无字幕(langs 空)→ 不带任何字幕参数", () => {
	const args = buildDownloadArgs(
		{ url: "https://example.com/v", outputDir: "out" },
		{ targetHeight: 480, isVertical: false, subtitlePlan: { langs: "", includeAuto: false } },
	);
	assert.ok(!args.includes("--write-subs"));
	assert.ok(!args.includes("--write-auto-subs"));
	assert.ok(!args.includes("--sub-langs"));
});

test("buildDownloadArgs: target undefined → 通用回退格式", () => {
	const args = buildDownloadArgs(
		{ url: "https://example.com/v", outputDir: "out" },
		{ targetHeight: undefined, isVertical: false, subtitlePlan: { langs: "", includeAuto: false } },
	);
	assert.ok(args.includes("bv*+ba/b"));
});

// ============================================================
// parseCliArgs
// ============================================================
test("parses cli args", () => {
	assert.deepEqual(parseCliArgs([
		"--url", "https://x.com/u/status/1?s=20",
		"--output-dir", "out",
		"--max-height", "1080",
		"--sub-langs", "en,zh",
		"--cookies-from-browser", "chrome",
	]), {
		url: "https://x.com/u/status/1?s=20",
		outputDir: "out",
		maxHeight: 1080,
		subLangs: "en,zh",
		cookiesFromBrowser: "chrome",
	});
});

// ============================================================
// parseInput — "指定 vs 未指定" 的咽喉(决定走用户指定还是自动选择)
// ponytail: 这是分辨率/字幕智能选择的语义入口,必须独立覆盖。
// ============================================================
test("parseInput: 仅 url 必填,未指定 maxHeight/subLangs 时字段缺失(走自动选择)", () => {
	const r = parseInput([], { TASK_INPUT: JSON.stringify({ url: "https://example.com/v" }), TASK_OUTPUT_DIR: "out" });
	assert.equal(r.url, "https://example.com/v");
	assert.equal(r.outputDir, "out");
	assert.equal(r.cookiesFromBrowser, "none");
	assert.ok(!("maxHeight" in r), "maxHeight 应缺失,让脚本走自动选择");
	assert.ok(!("subLangs" in r), "subLangs 应缺失,让脚本走自动选择");
});

test("parseInput: 指定 maxHeight 正数 → 带上(整数化)", () => {
	const r = parseInput([], { TASK_INPUT: JSON.stringify({ url: "https://example.com/v", maxHeight: 720 }), TASK_OUTPUT_DIR: "out" });
	assert.equal(r.maxHeight, 720);
	const r2 = parseInput([], { TASK_INPUT: JSON.stringify({ url: "https://example.com/v", maxHeight: 720.9 }), TASK_OUTPUT_DIR: "out" });
	assert.equal(r2.maxHeight, 720); // Math.floor
});

test("parseInput: maxHeight 为 0/负数/NaN/空串 → 视为未指定(字段缺失)", () => {
	for (const bad of [0, -5, NaN, "", null]) {
		const r = parseInput([], { TASK_INPUT: JSON.stringify({ url: "https://example.com/v", maxHeight: bad }), TASK_OUTPUT_DIR: "out" });
		assert.ok(!("maxHeight" in r), `maxHeight=${bad} 应被视为未指定`);
	}
});

test("parseInput: 指定 subLangs 非空 → 带上(trim);空串/纯空白 → 缺失", () => {
	const r1 = parseInput([], { TASK_INPUT: JSON.stringify({ url: "https://example.com/v", subLangs: "  en,zh  " }), TASK_OUTPUT_DIR: "out" });
	assert.equal(r1.subLangs, "en,zh");
	for (const bad of ["", "   "]) {
		const r = parseInput([], { TASK_INPUT: JSON.stringify({ url: "https://example.com/v", subLangs: bad }), TASK_OUTPUT_DIR: "out" });
		assert.ok(!("subLangs" in r), `subLangs=${JSON.stringify(bad)} 应被视为未指定`);
	}
});

test("parseInput: cli 覆盖 TASK_INPUT;缺 TASK_OUTPUT_DIR 报错", () => {
	const r = parseInput(["--url", "https://example.com/v", "--output-dir", "cliout", "--max-height", "1080"], { TASK_INPUT: JSON.stringify({ maxHeight: 480 }), TASK_OUTPUT_DIR: "envout" });
	assert.equal(r.outputDir, "cliout"); // cli 优先
	assert.equal(r.maxHeight, 1080); // cli 覆盖 env
	assert.throws(() => parseInput([], { TASK_INPUT: JSON.stringify({ url: "https://example.com/v" }) }), /TASK_OUTPUT_DIR is required/);
});

