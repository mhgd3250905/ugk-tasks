import { strict as assert } from "node:assert";
import test from "node:test";

import {
	buildSrt,
	cleanSubtitle,
	computeStats,
	dedupeEchoes,
	detectFormat,
	formatSrtTimestamp,
	hasSubtitleMarker,
	parseAnyFormat,
	parseSubtitleText,
	parseTtml,
	parseTimecode,
	rerouteOverlap,
	stripSubtitleMarkers,
} from "./clean-subtitle.mjs";

// 辅助
const cue = (index, s, e, text) => ({ index, startMs: s, endMs: e, text });
const srt = (cues) => cues.map(([s, e, t], i) =>
	`${i + 1}\n00:00:${String(Math.floor(s / 1000)).padStart(2, "0")},${String(s % 1000).padStart(3, "0")} --> 00:00:${String(Math.floor(e / 1000)).padStart(2, "0")},${String(e % 1000).padStart(3, "0")}\n${t}\n`).join("\n");
const ttml = (cues) => {
	const tc = (ms) => `00:00:${String(Math.floor(ms / 1000)).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
	return '<?xml version="1.0"?>\n<tt><body><div>\n' + cues.map(([s, e, t]) => `<p begin="${tc(s)}" end="${tc(e)}">${t}</p>`).join("\n") + "\n</div></body></tt>";
};

// ============================================================
// detectFormat
// ============================================================
test("detectFormat: 识别 TTML/VTT/SRT", () => {
	assert.equal(detectFormat('<?xml version="1.0"?><tt>'), "ttml");
	assert.equal(detectFormat("<tt xml:lang=\"en\">"), "ttml");
	assert.equal(detectFormat("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi"), "vtt");
	assert.equal(detectFormat("1\n00:00:01,000 --> 00:00:02,000\nhi"), "srt");
	assert.equal(detectFormat("garbage"), "unknown");
});

// ============================================================
// parseTimecode
// ============================================================
test("parseTimecode: SRT逗号 + VTT点号 都支持", () => {
	assert.equal(parseTimecode("00:00:01,500"), 1500);
	assert.equal(parseTimecode("00:00:01.500"), 1500);
	assert.equal(parseTimecode("00:01:01.500"), 61500);
	assert.equal(parseTimecode("01:01.5"), 61500); // MM:SS.m
});

test("parseTimecode: 非法抛错(注意:不校验分量范围,只校验结构)", () => {
	// ponytail: parseTimecode 是宽容设计 — 不校验 99 分这种越界值(审查 X2),
	// 只对结构性坏值(非数字/缺段)抛错。钉死这个现状。
	assert.throws(() => parseTimecode("abc"), /Invalid/);
	assert.throws(() => parseTimecode(""), /Invalid/);
	// "99:99" 是合法结构(MM:SS),解析成 99*60+99 秒,不抛错 — 这是已知宽容
	assert.equal(parseTimecode("99:99"), (99 * 60 + 99) * 1000);
});

// ============================================================
// parseSubtitleText (SRT/VTT) + Q1d 修复
// ============================================================
test("parseSubtitleText: SRT 正常解析", () => {
	const cues = parseSubtitleText(srt([[1000, 3000, "hello"], [4000, 6000, "world"]]));
	assert.equal(cues.length, 2);
	assert.equal(cues[0].text, "hello");
});

test("parseSubtitleText: 零时长 cue 报错(Q1d,不静默丢)", () => {
	assert.throws(() => parseSubtitleText(srt([[1000, 3000, "ok"], [4000, 4000, "lost"]], )), /invalid timing/i);
});

test("parseSubtitleText: 纯 marker cue 丢弃(marker 不算内容)", () => {
	const cues = parseSubtitleText(srt([[1000, 3000, "real"], [4000, 6000, "[Cheering]"], [7000, 9000, "more"]]));
	assert.equal(cues.length, 2);
	assert.deepEqual(cues.map((c) => c.index), [1, 2]);
});

// ============================================================
// parseTtml
// ============================================================
test("parseTtml: 解析 TTML,去 HTML 实体", () => {
	const cues = parseTtml(ttml([[1000, 3000, "yo what&#39;s up"], [3000, 5000, "second &amp; line"]]));
	assert.equal(cues.length, 2);
	assert.equal(cues[0].text, "yo what's up");
	assert.equal(cues[1].text, "second & line");
});

test("parseTtml: 解码数字字符引用 &#39;", () => {
	const cues = parseTtml(ttml([[1000, 3000, "it&#39;s"]]));
	assert.equal(cues[0].text, "it's");
});

test("parseTtml: 空 TTML 抛错", () => {
	assert.throws(() => parseTtml('<?xml version="1.0"?><tt><body></body></tt>'), /No TTML cues/);
});

// ============================================================
// parseAnyFormat (自动识别)
// ============================================================
test("parseAnyFormat: 自动识别 TTML 并解析", () => {
	const { format, cues } = parseAnyFormat(ttml([[1000, 3000, "hi"]]));
	assert.equal(format, "ttml");
	assert.equal(cues.length, 1);
});

test("parseAnyFormat: 自动识别 VTT", () => {
	const { format } = parseAnyFormat("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n");
	assert.equal(format, "vtt");
});

test("parseAnyFormat: 未知格式抛错", () => {
	assert.throws(() => parseAnyFormat("totally garbage"), /Unrecognized/);
});

// ============================================================
// dedupeEchoes — 核心新逻辑:去滚动回声碎片
// ============================================================
test("dedupeEchoes: 删除 YouTube 滚动回声(短cue+文本是相邻子串)", () => {
	// 真实 YouTube 模式:长cue + 10ms回声(回声文本是长cue子串)
	const cues = [
		cue(1, 2640, 4790, "yo what's up everybody this is meno welcome"), // 长
		cue(2, 4790, 4800, "welcome to stepx and today"), // 短回声(注意是下一句的前缀,不是上一句子串)
		cue(3, 4800, 6880, "welcome to stepx and today we're gonna start"), // 长
	];
	// cue2 文本 "welcome to stepx and today" 是 cue3 的子串 → 是回声 → 删除
	const r = dedupeEchoes(cues);
	assert.equal(r.length, 2);
	assert.deepEqual(r.map((c) => c.text), ["yo what's up everybody this is meno welcome", "welcome to stepx and today we're gonna start"]);
});

test("dedupeEchoes: 长cue不动(只删短回声)", () => {
	const cues = [
		cue(1, 1000, 3000, "long enough text here"), // 长,保留
		cue(2, 3000, 3010, "long enough text here"), // 短回声(子串),删
	];
	const r = dedupeEchoes(cues);
	assert.equal(r.length, 1);
	assert.equal(r[0].text, "long enough text here");
});

test("dedupeEchoes: 短cue但非回声(文本无关)保留", () => {
	// 两个短cue,但文本互不为子串 → 不是回声,都保留(可能是真实的短对白)
	const cues = [
		cue(1, 1000, 1100, "yes"), // 短
		cue(2, 1100, 1200, "no"), // 短,文本无关
	];
	const r = dedupeEchoes(cues);
	assert.equal(r.length, 2);
});

test("dedupeEchoes: 去重后 index 重新连续编号", () => {
	const cues = [
		cue(1, 1000, 3000, "aaa bbb ccc"),
		cue(2, 3000, 3010, "aaa bbb ccc"), // 回声删
		cue(3, 3010, 5000, "ddd eee fff"),
	];
	const r = dedupeEchoes(cues);
	assert.deepEqual(r.map((c) => c.index), [1, 2]);
});

test("dedupeEchoes: 空数组安全", () => {
	assert.deepEqual(dedupeEchoes([]), []);
});

// ============================================================
// rerouteOverlap — 重排重叠时间为首尾相接
// ============================================================
test("rerouteOverlap: 重叠改成首尾相接", () => {
	// cue1: 0-4000, cue2: 2000-6000(重叠)→ cue1 end 改 2000
	const cues = [cue(1, 0, 4000, "a"), cue(2, 2000, 6000, "b")];
	const r = rerouteOverlap(cues);
	assert.equal(r[0].endMs, 2000);
	assert.equal(r[1].startMs, 2000);
});

test("rerouteOverlap: 无重叠不动", () => {
	const cues = [cue(1, 1000, 3000, "a"), cue(2, 4000, 6000, "b")];
	const r = rerouteOverlap(cues);
	assert.equal(r[0].endMs, 3000); // 不变
	assert.equal(r[1].startMs, 4000);
});

test("rerouteOverlap: 重排不产生零时长(源严重病态时保原值)", () => {
	// cue1: 0-10000, cue2: 2000-4000(完全嵌套)→ cue2 重排后 end=min(4000,无下条)=4000 正常
	const cues = [cue(1, 0, 10000, "a"), cue(2, 2000, 4000, "b")];
	const r = rerouteOverlap(cues);
	assert.ok(r[1].endMs > r[1].startMs, "不应零时长");
});

// ============================================================
// stripSubtitleMarkers / hasSubtitleMarker
// ============================================================
test("stripSubtitleMarkers: 去音效标记(含数字保留)", () => {
	assert.equal(stripSubtitleMarkers("[Music] hi"), " hi");
	assert.equal(stripSubtitleMarkers("[Applause]"), "");
	assert.equal(stripSubtitleMarkers("[3D] keep"), "[3D] keep");
});

test("hasSubtitleMarker: 检测", () => {
	assert.equal(hasSubtitleMarker("[Music] hi"), true);
	assert.equal(hasSubtitleMarker("plain text"), false);
});

// ============================================================
// cleanSubtitle — 主流程端到端
// ============================================================
test("cleanSubtitle: TTML 滚动字幕 → 干净 SRT(去重+重排)", () => {
	// 模拟 YouTube TTML:三句重叠的滚动
	const input = ttml([
		[480, 4799, "yo what's up everybody this is meno"],
		[2639, 6890, "welcome to stepx and today we're gonna"],
		[4799, 10960, "start with some back rock variations"],
	]);
	const result = cleanSubtitle(input);
	assert.equal(result.format, "ttml");
	// TTML 没有回声碎片(本来就是干净的),去重不删;重排消除重叠
	assert.equal(result.cues.length, 3);
	assert.equal(result.stats.overlapCount, 0, "重排后应无重叠");
});

test("cleanSubtitle: VTT 带回声碎片 → 去重", () => {
	// VTT 模式:长cue + 10ms回声
	const input = "WEBVTT\n\n" + [
		[2640, 4790, "yo what's up everybody this is meno welcome"],
		[4790, 4800, "yo what's up everybody this is meno welcome"], // 回声(子串)
		[4800, 6880, "start with some back rock variations"],
	].map(([s, e, t], i) => `${i + 1}\n00:00:0${Math.floor(s / 1000)}.${String(s % 1000).padStart(3, "0")} --> 00:00:0${Math.floor(e / 1000)}.${String(e % 1000).padStart(3, "0")}\n${t}\n`).join("\n");
	const result = cleanSubtitle(input);
	assert.equal(result.format, "vtt");
	assert.ok(result.cues.length <= 2, "回声应被去重");
	assert.equal(result.stats.overlapCount, 0);
});

test("cleanSubtitle: 输出合法 SRT(可回流解析)", () => {
	const input = ttml([[1000, 3000, "first"], [2000, 5000, "second"]]);
	const result = cleanSubtitle(input);
	// 回流解析 SRT 应成功且无重叠
	const reparsed = parseSubtitleText(result.srt);
	assert.ok(reparsed.length >= 1);
	for (let i = 0; i < reparsed.length - 1; i++) {
		assert.ok(reparsed[i].endMs <= reparsed[i + 1].startMs, `cue ${i} 重叠`);
	}
});

test("cleanSubtitle: 只剩 marker 的字幕报错(清完没内容)", () => {
	const input = srt([[1000, 3000, "[Music]"], [4000, 6000, "[Applause]"]]);
	assert.throws(() => cleanSubtitle(input), /removed all cues|No subtitle/i);
});

// ============================================================
// computeStats
// ============================================================
test("computeStats: 统计 cue/重叠/短", () => {
	const cues = [cue(1, 1000, 3000, "a"), cue(2, 2500, 4000, "b"), cue(3, 4000, 4050, "c")];
	const s = computeStats(cues);
	assert.equal(s.cueCount, 3);
	assert.equal(s.overlapCount, 1); // cue2.start(2500) < cue1.end(3000)
	assert.equal(s.shortCount, 1); // cue3 50ms
	assert.equal(s.firstStartMs, 1000);
	assert.equal(s.lastEndMs, 4050);
});

// ============================================================
// formatSrtTimestamp / buildSrt
// ============================================================
test("formatSrtTimestamp + buildSrt", () => {
	assert.equal(formatSrtTimestamp(1500), "00:00:01,500");
	const srtText = buildSrt([cue(1, 1000, 3000, "hi")]);
	assert.ok(srtText.includes("00:00:01,000 --> 00:00:03,000"));
	assert.ok(srtText.includes("hi"));
});
