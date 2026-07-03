import { strict as assert } from "node:assert";
import test from "node:test";

import { assessSubtitleQuality } from "./subtitle-quality.mjs";

const cue = (s, e, text) => ({ startMs: s, endMs: e, text });

// 辅助:批量构造
function cues(arr) { return arr.map(([s, e, t]) => cue(s, e, t)); }

test("assessSubtitleQuality: 正常字幕放行(清洗后形态:0%短cue)", () => {
	const cs = cues([[1000, 3000, "第一句"], [3000, 5000, "第二句"], [5000, 7000, "第三句"]]);
	const r = assessSubtitleQuality(cs);
	assert.equal(r.verdict, "pass");
	assert.equal(r.signals.shortPct, 0);
});

test("assessSubtitleQuality: whisper 转写放行(11%短cue,少量残片)", () => {
	// 模拟 whisper:19条,2条短(11%),1个残片 "um"。正常产物,该放行
	const cs = cues([
		[1000, 3000, "hello everyone"], [3000, 5000, "today we learn"], [5000, 5100, "um"],
		[5100, 7000, "breaking"], [7000, 9000, "footwork"], [9000, 11000, "freeze"],
		[11000, 13000, "toprock"], [13000, 15000, "power move"], [15000, 17000, "drop"],
		[17000, 19000, "six step"], [19000, 21000, "cc"], [21000, 23000, "baby"],
		[23000, 25000, "chair"], [25000, 27000, "air chair"], [27000, 29000, "halo"],
		[29000, 31000, "windmill"], [31000, 33000, "flare"], [33000, 34000, "go"],
		[34000, 36000, "end"],
	]);
	const r = assessSubtitleQuality(cs);
	assert.equal(r.verdict, "pass");
	assert.ok(r.signals.shortPct <= 25, `whisper 短cue ${r.signals.shortPct}% 应放行`);
});

test("assessSubtitleQuality: 脏 YouTube VTT 打回(49%短cue=回声碎片)", () => {
	// 模拟 YouTube 脏字幕:长cue + 10ms回声交替,短cue占比 ~49%
	const cs = [];
	for (let i = 0; i < 100; i += 1) {
		const base = i * 3000;
		cs.push(cue(base, base + 10, `line ${i}`));          // 10ms 回声
		cs.push(cue(base, base + 2500, `line ${i} continued`)); // 长 cue
	}
	// 200 cue,100 个短 = 50% > 25% → 打回
	const r = assessSubtitleQuality(cs);
	assert.equal(r.verdict, "reject");
	assert.ok(r.signals.shortPct > 25);
	assert.match(r.reason, /short cues/i);
	// ponytail: reason 只描述问题,不指定用什么工具清洗(task 独立)
	assert.ok(!r.reason.includes("subtitle-cleaner"), "reason 不应指定工具名");
	assert.ok(!("suggest" in r), "不应有 suggest 字段");
});

test("assessSubtitleQuality: 全是音效标记无对白 → 打回", () => {
	const cs = cues([[1000, 3000, "[Music]"], [4000, 6000, "[Applause]"], [7000, 9000, "[Laughter]"]]);
	const r = assessSubtitleQuality(cs);
	assert.equal(r.verdict, "reject");
	assert.equal(r.signals.hasSpeech, false);
	assert.match(r.reason, /no speech/i);
	assert.ok(!r.reason.includes("subtitle-cleaner"), "reason 不应指定工具名");
});

test("assessSubtitleQuality: 大量重复文本(>20%) → 打回", () => {
	// 5条里4条完全重复 = 80% dup
	const cs = cues([
		[1000, 3000, "same text"], [3100, 5000, "same text"], [5100, 7000, "same text"],
		[7100, 9000, "same text"], [9100, 11000, "unique here"],
	]);
	const r = assessSubtitleQuality(cs);
	assert.equal(r.verdict, "reject");
	assert.ok(r.signals.dupPct > 20);
	assert.match(r.reason, /duplicate/i);
});

test("assessSubtitleQuality: 空数组 → 打回(no cues)", () => {
	const r = assessSubtitleQuality([]);
	assert.equal(r.verdict, "reject");
	assert.match(r.reason, /no subtitle cues/);
});

test("assessSubtitleQuality: 正常字幕有少量重复(2%)放行", () => {
	// 清洗后真实数据:213条,5条重复=2%。该放行
	const cs = [];
	for (let i = 0; i < 100; i += 1) cs.push(cue(i * 2000, i * 2000 + 1500, `line ${i}`));
	cs[50].text = "line 49"; // 1个重复 = 1%
	const r = assessSubtitleQuality(cs);
	assert.equal(r.verdict, "pass");
});

test("assessSubtitleQuality: signals 字段完整(诊断用)", () => {
	const r = assessSubtitleQuality(cues([[1000, 3000, "hi"], [3000, 5000, "there"]]));
	assert.ok("total" in r.signals);
	assert.ok("shortPct" in r.signals);
	assert.ok("dupPct" in r.signals);
	assert.ok("fragCount" in r.signals);
	assert.ok("hasSpeech" in r.signals);
	assert.equal(r.signals.total, 2);
});
