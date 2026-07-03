import { strict as assert } from "node:assert";
import test from "node:test";

import { assessSubtitleQuality, stripSubtitleMarkers } from "./subtitle-quality.mjs";

const cue = (s, e, text) => ({ startMs: s, endMs: e, text });
const cues = (arr) => arr.map(([s, e, t]) => cue(s, e, t));

test("assessSubtitleQuality: 正常中文字幕放行", () => {
	const r = assessSubtitleQuality(cues([[1000, 3000, "第一句"], [3000, 5000, "第二句"]]));
	assert.equal(r.verdict, "pass");
});

test("assessSubtitleQuality: 脏字幕(49%短cue)打回 + 提示 cleaner", () => {
	const cs = [];
	for (let i = 0; i < 100; i += 1) {
		cs.push(cue(i * 3000, i * 3000 + 10, `line ${i}`));
		cs.push(cue(i * 3000, i * 3000 + 2500, `line ${i} continued`));
	}
	const r = assessSubtitleQuality(cs);
	assert.equal(r.verdict, "reject");
	assert.ok(!r.reason.includes("subtitle-cleaner"), "reason 不应指定工具名");
	assert.match(r.reason, /short cues/i);
});

test("assessSubtitleQuality: 全是音效标记 → 打回", () => {
	const r = assessSubtitleQuality(cues([[1000, 3000, "[Music]"], [4000, 6000, "[Applause]"]]));
	assert.equal(r.verdict, "reject");
	assert.equal(r.signals.hasSpeech, false);
	assert.match(r.reason, /no speech/i);
});

test("assessSubtitleQuality: 大量重复(>20%) → 打回", () => {
	const cs = cues([[1000, 3000, "same"], [3100, 5000, "same"], [5100, 7000, "same"], [7100, 9000, "same"], [9100, 11000, "ok"]]);
	assert.equal(assessSubtitleQuality(cs).verdict, "reject");
});

test("assessSubtitleQuality: 空数组打回", () => {
	assert.equal(assessSubtitleQuality([]).verdict, "reject");
});

test("stripSubtitleMarkers: 剥离音效标记(自包含,不依赖 translator)", () => {
	assert.equal(stripSubtitleMarkers("[Music] hi"), " hi");
	assert.equal(stripSubtitleMarkers("[Applause]"), "");
	assert.equal(stripSubtitleMarkers("[3D] keep"), "[3D] keep");
});
