import { strict as assert } from "node:assert";
import test from "node:test";

import {
	buildFluentSrt,
	defaultMaxUnitChars,
	formatSrtTimestamp,
	hasCjk,
	hasSubtitleMarker,
	parseCliArgs,
	parseSubtitleText,
	stripSubtitleMarkers,
	validateUnits,
} from "./make-fluent-subtitle.mjs";

// ============================================================
// 辅助构造
// ============================================================
function cue(index, startMs, endMs, text) {
	return { index, startMs, endMs, text };
}
function srt(cues) {
	// cues: [[startMs,endMs,text],...]
	return cues.map(([s, e, t], i) =>
		`${i + 1}\n00:00:${String(Math.floor(s / 1000)).padStart(2, "0")},${String(s % 1000).padStart(3, "0")} --> 00:00:${String(Math.floor(e / 1000)).padStart(2, "0")},${String(e % 1000).padStart(3, "0")}\n${t}\n`
	).join("\n");
}
function vtt(cues) {
	// cues: [[startMs,endMs,text],...] VTT 用 . 分隔毫秒
	const tc = (ms) => `00:00:${String(Math.floor(ms / 1000)).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
	return "WEBVTT\n\n" + cues.map(([s, e, t], i) => `${i + 1}\n${tc(s)} --> ${tc(e)}\n${t}\n`).join("\n");
}
function srcCues(cues) {
	// [[startMs,endMs,text],...] → 带 index 的 sourceCues
	return cues.map(([s, e, t], i) => cue(i + 1, s, e, t));
}

// ============================================================
// parseSubtitleText — 字幕解析
// ============================================================
test("parseSubtitleText: 解析 SRT 格式", () => {
	const cues = parseSubtitleText(srt([[1000, 3000, "hello"], [4000, 6000, "world"]]));
	assert.equal(cues.length, 2);
	assert.equal(cues[0].index, 1);
	assert.equal(cues[0].startMs, 1000);
	assert.equal(cues[0].endMs, 3000);
	assert.equal(cues[0].text, "hello");
});

test("parseSubtitleText: 解析 VTT 格式(. 分隔毫秒)", () => {
	const cues = parseSubtitleText(vtt([[1000, 3000, "hello"]]));
	assert.equal(cues.length, 1);
	assert.equal(cues[0].startMs, 1000);
	assert.equal(cues[0].endMs, 3000);
});

test("parseSubtitleText: VTT 无 cue header(直接 timing 行)也能解析", () => {
	const text = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nhello\n";
	const cues = parseSubtitleText(text);
	assert.equal(cues.length, 1);
	assert.equal(cues[0].text, "hello");
});

test("parseSubtitleText: 去掉 HTML 标签 + 多空白归一", () => {
	const cues = parseSubtitleText(srt([[1000, 3000, "<c>hello</c>   world  &amp;   you"]]));
	assert.equal(cues[0].text, "hello world & you");
});

test("parseSubtitleText: 空字幕抛错", () => {
	assert.throws(() => parseSubtitleText(""), /No subtitle cues found/);
	assert.throws(() => parseSubtitleText("WEBVTT\n\nNOTE just a note\n"), /No subtitle cues found/);
});

test("parseSubtitleText: index 连续累加(即使有被过滤的行)", () => {
	// 纯 marker cue(清洗后为空)会被丢弃,但后续 index 连续
	const text = srt([[1000, 3000, "real text"], [4000, 6000, "[Cheering]"], [7000, 9000, "more text"]]);
	const cues = parseSubtitleText(text);
	// [Cheering] 被清洗掉 → 丢弃,剩 2 条,index 仍是 1,2(不跳号)
	assert.equal(cues.length, 2);
	assert.deepEqual(cues.map((c) => c.index), [1, 2]);
	assert.equal(cues[1].text, "more text");
});

// ============================================================
// ★ TDD 红:parseSubtitleText 零时长/倒置 cue 不应静默丢文本
// 当前行为:静默丢弃,文本消失。期望:报错拦截(不偷偷丢内容)。
// ============================================================
test("parseSubtitleText: 零时长 cue(开始==结束)应报错,不静默丢文本", () => {
	// ASR 常见产物:endMs==startMs。当前偷偷扔掉那行文字。
	// 期望:报错,让用户知道字幕有问题,而不是产出缺句的结果。
	const text = srt([[1000, 3000, "第一句"], [4000, 4000, "重要中间句"], [5000, 7000, "第三句"]]);
	assert.throws(() => parseSubtitleText(text), /0.*duration|zero|invalid.*time|end.*start/i, "零时长 cue 应报错而非静默丢弃文本");
});

test("parseSubtitleText: 倒置时间码(开始>结束)应报错", () => {
	const text = srt([[1000, 3000, "第一句"], [5000, 4000, "倒置的句"], [6000, 8000, "第三句"]]);
	assert.throws(() => parseSubtitleText(text), /invalid|reverse|end.*start|start.*end/i);
});

// ============================================================
// stripSubtitleMarkers / hasSubtitleMarker — 括号标记
// ============================================================
test("stripSubtitleMarkers: 剥离短括号音效标记(保留周围空格,不额外 trim)", () => {
	// ponytail: stripSubtitleMarkers 只替换 marker 本身,不动周围空格(空格归一由 cleanSubtitleText 负责)
	assert.equal(stripSubtitleMarkers("[Cheering] hello"), " hello");
	assert.equal(stripSubtitleMarkers("hello [music]"), "hello ");
	assert.equal(stripSubtitleMarkers("【环境音】你好"), "你好");
	assert.equal(stripSubtitleMarkers("(applause) go"), " go");
});

test("stripSubtitleMarkers: 剥离非括号音符符号(♪♫🎵等,音乐视频常见)", () => {
	// ponytail: 非括号音效符号补丁——这些在括号正则之外,原本漏网
	assert.equal(stripSubtitleMarkers("♪♪♪ 对白"), " 对白");
	assert.equal(stripSubtitleMarkers("♫ 对白"), " 对白");
	assert.equal(stripSubtitleMarkers("🎵 对白"), " 对白");
	assert.equal(stripSubtitleMarkers("♬欢迎回来"), "欢迎回来");
	// 对白里的正常文字不动
	assert.equal(stripSubtitleMarkers("正常中文对白"), "正常中文对白");
});

test("hasSubtitleMarker: 检测音符符号", () => {
	assert.equal(hasSubtitleMarker("♪♪♪ 对白"), true);
	assert.equal(hasSubtitleMarker("🎵 music"), true);
	assert.equal(hasSubtitleMarker("plain text"), false);
	assert.equal(hasSubtitleMarker("正常对白"), false);
});

test("stripSubtitleMarkers: 含数字的括号保留(不当 marker)", () => {
	assert.equal(stripSubtitleMarkers("[3D] model"), "[3D] model");
	assert.equal(stripSubtitleMarkers("[2024]"), "[2024]");
});

test("stripSubtitleMarkers: 25字符以上长括号保留(当正文)", () => {
	const long = "[" + "a".repeat(25) + "]";
	assert.equal(stripSubtitleMarkers(long), long);
	const just24 = "[" + "a".repeat(24) + "]";
	assert.equal(stripSubtitleMarkers(just24), "");
});

test("hasSubtitleMarker: 检测是否存在 marker", () => {
	assert.equal(hasSubtitleMarker("[Cheering] hi"), true);
	assert.equal(hasSubtitleMarker("just normal text"), false);
});

// ============================================================
// formatSrtTimestamp / hasCjk
// ============================================================
test("formatSrtTimestamp: 毫秒转 SRT 时间码", () => {
	assert.equal(formatSrtTimestamp(0), "00:00:00,000");
	assert.equal(formatSrtTimestamp(1500), "00:00:01,500");
	assert.equal(formatSrtTimestamp(3661500), "01:01:01,500");
});

test("hasCjk: 检测中文", () => {
	assert.equal(hasCjk("你好"), true);
	assert.equal(hasCjk("hello"), false);
	assert.equal(hasCjk("mix 中文"), true);
});

// ============================================================
// validateUnits — 单元校验
// ============================================================
test("validateUnits: 正常合并相邻 cue", () => {
	const sources = srcCues([[1000, 3000, "a"], [3000, 5000, "b"], [5000, 7000, "c"]]);
	const units = [{ ids: [1, 2], text: "合并ab" }, { ids: [3], text: "c" }];
	const r = validateUnits(sources, units);
	assert.equal(r.length, 2);
	assert.equal(r[0].startMs, 1000);
	assert.equal(r[0].endMs, 5000);
	assert.equal(r[1].startMs, 5000);
	assert.equal(r[1].endMs, 7000);
});

test("validateUnits: ids 必须完整覆盖(缺号报错)", () => {
	const sources = srcCues([[1000, 3000, "a"], [3000, 5000, "b"], [5000, 7000, "c"]]);
	const units = [{ ids: [1, 2], text: "ab" }]; // 漏了 3
	assert.throws(() => validateUnits(sources, units), /missing cue ids: 3/);
});

test("validateUnits: 跨 unit 跳号 → missing 报错", () => {
	const sources = srcCues([[1000, 3000, "a"], [3000, 5000, "b"], [5000, 7000, "c"], [7000, 9000, "d"]]);
	const units = [{ ids: [1, 2], text: "ab" }, { ids: [4], text: "d" }]; // 跳过 3
	assert.throws(() => validateUnits(sources, units), /missing cue ids: 3/);
});

test("validateUnits: 单元内 ids 不连续报错", () => {
	const sources = srcCues([[1000, 3000, "a"], [3000, 5000, "b"], [5000, 7000, "c"]]);
	const units = [{ ids: [1, 3], text: "ac" }]; // 跳了 2
	assert.throws(() => validateUnits(sources, units), /contiguous/);
});

test("validateUnits: 重复 id 报错", () => {
	const sources = srcCues([[1000, 3000, "a"], [3000, 5000, "b"]]);
	const units = [{ ids: [1], text: "a" }, { ids: [1], text: "a again" }];
	assert.throws(() => validateUnits(sources, units), /duplicate/);
});

test("validateUnits: 多 cue 合并超时长报错", () => {
	// 两个 cue 合并跨度 10s > maxUnitDurationMs 8000
	const sources = srcCues([[1000, 6000, "a"], [6000, 11000, "b"]]);
	const units = [{ ids: [1, 2], text: "合并" }];
	assert.throws(() => validateUnits(sources, units, { maxUnitDurationMs: 8000 }), /too long/);
});

test("validateUnits: 单 cue 本身超长豁免(不报错)", () => {
	// 单条 cue 50s,但 ids.length==1,豁免
	const sources = srcCues([[1000, 51000, "超长单句"]]);
	const units = [{ ids: [1], text: "超长单句中文" }];
	const r = validateUnits(sources, units, { maxUnitDurationMs: 8000 });
	assert.equal(r.length, 1);
});

test("validateUnits: 单元时长 <500ms 报错(要求合并)", () => {
	// 单 cue 时长 100ms
	const sources = srcCues([[1000, 1100, "短"]]);
	const units = [{ ids: [1], text: "短中文" }];
	assert.throws(() => validateUnits(sources, units), /too short|merge/i);
});

test("validateUnits: 文本超 maxUnitChars 报错", () => {
	const sources = srcCues([[1000, 3000, "a"]]);
	const longText = "字".repeat(91); // > 默认 90
	const units = [{ ids: [1], text: longText }];
	assert.throws(() => validateUnits(sources, units), /too long/);
});

test("validateUnits: 稀疏源片段禁止长输出(防幻觉)", () => {
	// 源只有 "go"(2字符 ≤ SPARSE_SOURCE_MAX_CHARS=12),worker 输出 > 20 字符 → 报错
	const sources = srcCues([[1000, 3000, "go"]]);
	const units = [{ ids: [1], text: "这是一段超过二十个字符的解释性幻觉输出文字内容" }]; // 24 字符 > 20
	assert.throws(() => validateUnits(sources, units), /sparse/i);
});

test("validateUnits: zh 目标必须有中文", () => {
	const sources = srcCues([[1000, 3000, "hello"]]);
	const units = [{ ids: [1], text: "hello no chinese" }];
	assert.throws(() => validateUnits(sources, units, { targetLanguage: "zh-CN" }), /CJK/);
});

// ============================================================
// buildFluentSrt — SRT 构建 + 单调性
// ============================================================
test("buildFluentSrt: 正常生成 SRT", () => {
	const sources = srcCues([[1000, 3000, "a"], [3000, 5000, "b"]]);
	const units = [{ ids: [1], text: "甲" }, { ids: [2], text: "乙" }];
	const srtText = buildFluentSrt(sources, units);
	assert.ok(srtText.includes("00:00:01,000 --> 00:00:03,000"));
	assert.ok(srtText.includes("甲"));
});

test("buildFluentSrt: 源 cue 轻微重叠(1-2ms)被 clamp 成单调", () => {
	// cue1: 1000-3000, cue2: 2999-5000(重叠 1ms)
	const sources = srcCues([[1000, 3000, "a"], [2999, 5000, "b"]]);
	const units = [{ ids: [1], text: "甲" }, { ids: [2], text: "乙" }];
	const srtText = buildFluentSrt(sources, units);
	// cue2 start 被 clamp 到 max(2999, 3000)=3000,不重叠
	assert.ok(srtText.includes("00:00:03,000 --> 00:00:05,000"));
});

// ============================================================
// ★ TDD 红:buildFluentSrt 嵌套重叠不应产出零时长 cue
// 当前行为:cue2 完全嵌在 cue1 内 → 产出 10000-10000 零时长废 cue。
// 期望:不产出零时长 cue(clamp 时保证 endMs > startMs 最小间隔)。
// ============================================================
test("buildFluentSrt: 嵌套重叠不产出零时长 cue", () => {
	// cue1: 0-10000(长), cue2: 2000-4000(嵌套在内),分属不同 unit
	const sources = srcCues([[0, 10000, "长句"], [2000, 4000, "短句"]]);
	const units = [{ ids: [1], text: "长句中文" }, { ids: [2], text: "短句中文" }];
	const srtText = buildFluentSrt(sources, units);
	// 回流解析,不应有零时长 cue
	const parsed = parseSubtitleText(srtText);
	for (const c of parsed) {
		assert.ok(c.endMs > c.startMs, `产出零时长 cue: ${c.startMs}-${c.endMs}`);
	}
	// 关键:cue2 不应被 clamp 成 10000-10000
	assert.equal(parsed.length, units.length, "嵌套场景应保留所有 unit,不丢");
});

// ============================================================
// 毛病2 修复:videoDurationSeconds 封顶
// ============================================================
test("buildFluentSrt: 最后一条 cue 用 videoDurationSeconds 封顶(500ms 撑过后)", () => {
	// 源 cue: 0-31000(31秒)。视频时长 30 秒。500ms 兜底不会触发(时长足够)。
	// 但若 cue 结束 31s > 视频 30s,封顶到 30s
	const sources = srcCues([[0, 31000, "结尾幻听"]]);
	const units = [{ ids: [1], text: "结尾幻听中文" }];
	const srtText = buildFluentSrt(sources, units, { videoDurationSeconds: 30 });
	const parsed = parseSubtitleText(srtText);
	assert.ok(parsed[0].endMs <= 30000, `封顶后 endMs=${parsed[0].endMs} 应 <= 30000`);
});

test("buildFluentSrt: 封顶不违反 500ms 最小时长(源数据矛盾时不封)", () => {
	// cue 29800-30300(500ms 合法,但越界),视频 30000。
	// 封顶到 30000 → 29800-30000=200ms<500ms 违反最小。此时不封顶(保留 30300),让 verify 抓越界。
	const sources = srcCues([[29800, 30300, "越界但合法时长"]]);
	const units = [{ ids: [1], text: "越界中文" }];
	const srtText = buildFluentSrt(sources, units, { videoDurationSeconds: 30 });
	const parsed = parseSubtitleText(srtText);
	// 封顶条件 videoDurationMs(30000) >= startMs(29800)+500(30300) 不成立 → 不封顶
	assert.ok(parsed[0].endMs - parsed[0].startMs >= 500, "不应为封顶产 <500ms 废 cue");
});

test("buildFluentSrt: 无 videoDurationSeconds 时不封顶(原行为不变)", () => {
	const sources = srcCues([[0, 31000, "正常"]]);
	const units = [{ ids: [1], text: "正常中文" }];
	const srtText = buildFluentSrt(sources, units);
	const parsed = parseSubtitleText(srtText);
	assert.equal(parsed[0].endMs, 31000); // 不封顶
});

// ============================================================
// parseCliArgs
// ============================================================
test("parseCliArgs: 正常解析各参数", () => {
	const args = parseCliArgs(["--subtitle", "a.srt", "--output-dir", "out", "--verbosity", "talkative", "--max-unit-chars", "80"]);
	assert.equal(args.subtitlePath, "a.srt");
	assert.equal(args.outputDir, "out");
	assert.equal(args.verbosity, "talkative");
	assert.equal(args.maxUnitChars, 80);
});

test("parseCliArgs: --preflight 标志", () => {
	const args = parseCliArgs(["--preflight", "--subtitle", "a.srt"]);
	assert.equal(args.preflight, true);
	assert.equal(args.subtitlePath, "a.srt");
});

test("parseCliArgs: verbosity 非法值报错", () => {
	assert.throws(() => parseCliArgs(["--verbosity", "loud"]), /normal or talkative/);
});

test("defaultMaxUnitChars: 返回 90(talkative 不放宽)", () => {
	assert.equal(defaultMaxUnitChars("normal"), 90);
	assert.equal(defaultMaxUnitChars("talkative"), 90);
});
