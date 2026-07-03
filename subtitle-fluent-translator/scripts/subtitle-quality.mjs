// 字幕输入质量门禁(纯函数,无 IO)。
// ponytail: task 各自独立,本文件是 translator 自持的副本;subtitle-to-speech 有一份同源副本。
// 不跨 task import(符合 task 独立原则)。判定逻辑确定性,不靠 LLM 主观。

import { stripSubtitleMarkers } from "./make-fluent-subtitle.mjs";
//
// 设计依据(实测数据,决定阈值):
//   脏 YouTube VTT(415cue,202回声):  shortPct=49%  dupPct=10%  → 该打回
//   whisper 转写(19cue):              shortPct=11%  dupPct=0%   → 该放行
//   subtitle-cleaner 清洗后(213cue):  shortPct=0%   dupPct=2%   → 该放行
// 阈值留足安全边际:脏49% vs 正常≤11%,短cue阈值定25%能干净分开。

const SHORT_CUE_MS = 500; // <500ms 算短cue(YouTube 回声碎片特征)
const FRAGMENT_MAX_CHARS = 3; // ≤3字符算 ASR 残片

/**
 * 评估字幕质量。返回 { verdict, signals, reason? }。
 *   - verdict "pass": 质量可接受,可继续处理
 *   - verdict "reject": 明显低质量,应打回(附 reason + 建议)
 * signals 含各项实测值,便于诊断。
 *
 * 三档独立信号,任一命中即 reject:
 *   1. shortPct > 25%   — YouTube 滚动回声碎片过多
 *   2. dupPct > 20%     — 大量重复文本(回声副本/循环bug)
 *   3. noSpeech         — 清理后无对白(全是音效标记)
 */
export function assessSubtitleQuality(cues) {
	const total = Array.isArray(cues) ? cues.length : 0;
	const signals = { total, shortPct: 0, dupPct: 0, fragCount: 0, hasSpeech: false };

	if (total === 0) {
		return { verdict: "reject", signals, reason: "no subtitle cues found" };
	}

	// 短 cue 占比
	const shortCount = cues.filter((c) => (c.endMs - c.startMs) < SHORT_CUE_MS).length;
	signals.shortPct = Math.round((shortCount / total) * 100);

	// 重复文本占比(完全相同的文本出现 >1 次)
	const texts = cues.map((c) => String(c.text || ""));
	const seen = new Set();
	const dupSet = new Set();
	for (const t of texts) {
		if (seen.has(t)) dupSet.add(t);
		else seen.add(t);
	}
	// 重复 cue 数 = 所有文本在 dupSet 里的 cue 数 - 每个重复文本留1个
	const dupCount = texts.filter((t) => dupSet.has(t)).length - dupSet.size;
	signals.dupPct = Math.round((Math.max(0, dupCount) / total) * 100);

	// ASR 残片数(诊断用,不单独触发reject)
	signals.fragCount = cues.filter((c) => {
		const t = String(c.text || "").trim();
		return t.length > 0 && t.length <= FRAGMENT_MAX_CHARS;
	}).length;

	// 是否有对白(去掉音效标记 [Music] 等之后还有非空文本才算对白)
	// ponytail: [Music]/[Applause] 是音效标记不是对白,不能当 hasSpeech=true。
	// 用 stripSubtitleMarkers 清掉短括号标记后判空。
	signals.hasSpeech = cues.some((c) => stripSubtitleMarkers(String(c.text || "")).trim().length > 0);

	// 判定(ponytail: reason 只描述问题 + 需要什么质量的输入,不指定用什么工具清洗——
	// task 各自独立,且用户可能没装任何清洗工具。工具由调用方/agent 决定。)
	if (!signals.hasSpeech) {
		return {
			verdict: "reject",
			signals,
			reason: "subtitle contains no speech text (only sound-effect markers like [Music]/[Applause]); needs a subtitle with actual dialogue",
		};
	}
	if (signals.shortPct > 25) {
		return {
			verdict: "reject",
			signals,
			reason: `too many short cues (${signals.shortPct}% < ${SHORT_CUE_MS}ms; threshold 25%) — likely uncleaned YouTube rolling echoes; needs a cleaned subtitle with rolling echoes removed`,
		};
	}
	if (signals.dupPct > 20) {
		return {
			verdict: "reject",
			signals,
			reason: `too many duplicate-text cues (${signals.dupPct}%; threshold 20%) — likely rolling echo duplicates; needs a deduplicated subtitle`,
		};
	}
	return { verdict: "pass", signals };
}
