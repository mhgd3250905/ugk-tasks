// 字幕输入质量门禁(纯函数,无 IO)。
// ponytail: task 各自独立,本文件是 to-speech 自持的副本;translator 有一份同源副本。
// 不跨 task import。注意:to-speech 的 cleanSubtitleText 不去音效标记,所以本文件
// 自带 stripSubtitleMarkers(内嵌标记剥离逻辑),用于判 hasSpeech。
//
// 设计依据(实测数据):
//   脏 YouTube VTT:  shortPct=49% → 该打回
//   whisper/清洗后:  shortPct≤11% → 该放行

const SHORT_CUE_MS = 500;
const FRAGMENT_MAX_CHARS = 3;
const BRACKET_CLOSE_BY_OPEN = { "【": "】", "[": "]", "(": ")", "（": "）" };
const SHORT_BRACKET_MARKER_RE = /([【\[\(（])\s*([^【】\[\]\(\)（）\r\n]{1,24})\s*([】\]\)）])/g;

function isShortBracketMarker(open, inner, close) {
	const marker = String(inner || "").trim();
	if (BRACKET_CLOSE_BY_OPEN[open] !== close) return false;
	if (!marker) return true;
	if (/[0-9]/.test(marker)) return false;
	if (/[.!?。！？,，、:：;；]/.test(marker)) return false;
	return /[A-Za-z\u3400-\u9fff]/.test(marker);
}

export function stripSubtitleMarkers(text) {
	return String(text ?? "").replace(SHORT_BRACKET_MARKER_RE, (match, open, inner, close) => (
		isShortBracketMarker(open, inner, close) ? "" : match
	));
}

/**
 * 评估字幕质量。三档独立信号,任一命中即 reject:
 *   1. shortPct > 25%  — YouTube 滚动回声碎片
 *   2. dupPct > 20%    — 大量重复文本
 *   3. noSpeech        — 清理音效标记后无对白
 */
export function assessSubtitleQuality(cues) {
	const total = Array.isArray(cues) ? cues.length : 0;
	const signals = { total, shortPct: 0, dupPct: 0, fragCount: 0, hasSpeech: false };

	if (total === 0) {
		return { verdict: "reject", signals, reason: "no subtitle cues found" };
	}

	const shortCount = cues.filter((c) => (c.endMs - c.startMs) < SHORT_CUE_MS).length;
	signals.shortPct = Math.round((shortCount / total) * 100);

	const texts = cues.map((c) => String(c.text || ""));
	const seen = new Set();
	const dupSet = new Set();
	for (const t of texts) {
		if (seen.has(t)) dupSet.add(t);
		else seen.add(t);
	}
	const dupCount = texts.filter((t) => dupSet.has(t)).length - dupSet.size;
	signals.dupPct = Math.round((Math.max(0, dupCount) / total) * 100);

	signals.fragCount = cues.filter((c) => {
		const t = String(c.text || "").trim();
		return t.length > 0 && t.length <= FRAGMENT_MAX_CHARS;
	}).length;

	// 去掉音效标记后还有非空文本才算对白
	signals.hasSpeech = cues.some((c) => stripSubtitleMarkers(String(c.text || "")).trim().length > 0);

	// (ponytail: reason 只描述问题 + 需要什么质量的输入,不指定用什么工具清洗。)
	if (!signals.hasSpeech) {
		return { verdict: "reject", signals, reason: "subtitle contains no speech text (only sound-effect markers like [Music]/[Applause]); needs a subtitle with actual dialogue" };
	}
	if (signals.shortPct > 25) {
		return { verdict: "reject", signals, reason: `too many short cues (${signals.shortPct}% < ${SHORT_CUE_MS}ms; threshold 25%) — likely uncleaned YouTube rolling echoes; needs a cleaned subtitle with rolling echoes removed` };
	}
	if (signals.dupPct > 20) {
		return { verdict: "reject", signals, reason: `too many duplicate-text cues (${signals.dupPct}%; threshold 20%) — likely rolling echo duplicates; needs a deduplicated subtitle` };
	}
	return { verdict: "pass", signals };
}
