import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ponytail: 本脚本是字幕解析的权威实现。subtitle-fluent-translator 历史上有自己的
// 解析逻辑(含已修复的 Q1d 静默丢文本 bug)。本 task 统一负责
// "把任何格式的脏字幕洗成干净标准 SRT",下游应引用此处而非各自维护。

const BRACKET_CLOSE_BY_OPEN = { "【": "】", "[": "]", "(": ")", "（": "）" };
const SHORT_BRACKET_MARKER_RE = /([【\[\(（])\s*([^【】\[\]\(\)（）\r\n]{1,24})\s*([】\]\)）])/g;
// 滚动回声判定阈值:YouTube 回声 cue 通常 <500ms 且文本是相邻 cue 子串。
const ECHO_MAX_DURATION_MS = 500;

// ============================================================
// 文本清洗(格式层,不碰语义)
// ============================================================
function isShortBracketMarker(open, inner, close) {
	const marker = String(inner || "").trim();
	if (BRACKET_CLOSE_BY_OPEN[open] !== close) return false;
	if (!marker) return true;
	if (/[0-9]/.test(marker)) return false; // 含数字保留(如 [3D])
	if (/[.!?。！？,，、:：;；]/.test(marker)) return false; // 含标点保留
	return /[A-Za-z\u3400-\u9fff]/.test(marker);
}

export function stripSubtitleMarkers(text) {
	return String(text ?? "").replace(SHORT_BRACKET_MARKER_RE, (match, open, inner, close) => (
		isShortBracketMarker(open, inner, close) ? "" : match
	));
}

export function hasSubtitleMarker(text) {
	const value = String(text ?? "");
	return stripSubtitleMarkers(value) !== value;
}

function cleanSubtitleText(text) {
	return String(text || "")
		.replace(/<[^>]+>/g, "") // HTML 标签
		.replace(SHORT_BRACKET_MARKER_RE, (match, open, inner, close) => (
			isShortBracketMarker(open, inner, close) ? "" : match
		))
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();
}

// ============================================================
// 格式识别
// ============================================================
export function detectFormat(text) {
	const value = String(text || "").trim().replace(/^\uFEFF/, "");
	if (value.startsWith("<?xml") || value.startsWith("<tt ")) return "ttml";
	if (value.startsWith("WEBVTT")) return "vtt";
	// SRT:第一行通常是数字 cue index
	if (/^\d+\s*\n\s*\d{2}:\d{2}/.test(value)) return "srt";
	// 兜底:有 timing 行就当 vtt/srt 同构处理
	if (/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(value)) return "srt";
	return "unknown";
}

// ============================================================
// 时间码 + SRT/VTT 解析(已修复 Q1d:坏时间码不静默丢文本)
// ============================================================
export function parseTimecode(value) {
	const normalized = String(value || "").trim().replace(",", ".");
	const [clock, fraction = "0"] = normalized.split(".");
	const parts = clock.split(":").map((part) => Number(part));
	if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
		throw new Error(`Invalid subtitle timecode: ${value}`);
	}
	const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
	return (((hours * 60 + minutes) * 60 + seconds) * 1000) + Number(fraction.padEnd(3, "0").slice(0, 3));
}

function parseTimingLine(line) {
	const match = String(line || "").match(/^\s*(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}/);
	if (!match) return null;
	const [startRaw, rest] = line.split("-->");
	const endRaw = rest.trim().split(/\s+/)[0];
	return { startMs: parseTimecode(startRaw), endMs: parseTimecode(endRaw) };
}

export function parseSubtitleText(text) {
	const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
	const cues = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();
		if (!line || line === "WEBVTT" || line.startsWith("NOTE")) continue;
		let timing = parseTimingLine(line);
		if (!timing && lines[index + 1]) {
			timing = parseTimingLine(lines[index + 1]);
			if (timing) index += 1;
		}
		if (!timing) continue;
		const textLines = [];
		index += 1;
		while (index < lines.length && lines[index].trim()) {
			textLines.push(lines[index]);
			index += 1;
		}
		const cueText = cleanSubtitleText(textLines.join(" "));
		// ponytail Q1d:区分两种情况,避免静默丢内容。
		//   - 文本空(纯 marker 清洗后为空)→ 丢弃(marker 不算内容,设计意图)
		//   - 文本非空但时间坏(endMs<=startMs:零时长/倒置)→ 报错拦截
		if (!cueText) continue;
		if (timing.endMs <= timing.startMs) {
			throw new Error(`cue at ${formatSrtTimestamp(timing.startMs)} has invalid timing: end (${formatSrtTimestamp(timing.endMs)}) <= start; text was "${cueText.slice(0, 40)}"`);
		}
		cues.push({ index: cues.length + 1, startMs: timing.startMs, endMs: timing.endMs, text: cueText });
	}
	if (cues.length === 0) throw new Error("No subtitle cues found");
	return cues;
}

// ============================================================
// TTML 解析(YouTube 等。XML 结构:<p begin="..." end="...">text</p>)
// ============================================================
function decodeXmlEntities(text) {
	return String(text || "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

export function parseTtml(text) {
	const value = String(text || "").replace(/^\uFEFF/, "");
	// 提取所有 <p begin="..." end="...">...</p>。容忍属性顺序/额外属性。
	const re = /<p\b[^>]*\bbegin="([^"]+)"[^>]*\bend="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
	const cues = [];
	let m;
	let index = 1;
	while ((m = re.exec(value))) {
		const cueText = cleanSubtitleText(decodeXmlEntities(m[3]));
		if (!cueText) continue; // marker-only 丢弃(同 SRT/VTT 语义)
		const startMs = parseTimecode(m[1]);
		const endMs = parseTimecode(m[2]);
		if (endMs <= startMs) {
			throw new Error(`TTML cue at ${formatSrtTimestamp(startMs)} has invalid timing: end <= start; text was "${cueText.slice(0, 40)}"`);
		}
		cues.push({ index: index++, startMs, endMs, text: cueText });
	}
	// TTML 的 begin/end 属性可能顺序颠倒,再扫一次 end 在前的情况
	if (cues.length === 0) {
		const re2 = /<p\b[^>]*\bend="([^"]+)"[^>]*\bbegin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
		while ((m = re2.exec(value))) {
			const cueText = cleanSubtitleText(decodeXmlEntities(m[3]));
			if (!cueText) continue;
			const startMs = parseTimecode(m[2]);
			const endMs = parseTimecode(m[1]);
			if (endMs <= startMs) throw new Error(`TTML cue invalid timing; text was "${cueText.slice(0, 40)}"`);
			cues.push({ index: index++, startMs, endMs, text: cueText });
		}
	}
	if (cues.length === 0) throw new Error("No TTML cues found");
	return cues;
}

// ============================================================
// 统一解析入口(自动识别格式)
// ============================================================
export function parseAnyFormat(text) {
	const format = detectFormat(text);
	if (format === "ttml") return { format, cues: parseTtml(text) };
	if (format === "vtt" || format === "srt") return { format, cues: parseSubtitleText(text) };
	throw new Error(`Unrecognized subtitle format (got "${format}"). Supported: TTML/VTT/SRT.`);
}

// ============================================================
// 去重:删除 YouTube 滚动回声碎片
// ponytail: 纯结构性去重,不是改写文本。识别"短cue + 文本是相邻cue子串"的回声副本。
// ============================================================
export function dedupeEchoes(cues, options = {}) {
	const maxDurationMs = Number(options.echoMaxDurationMs ?? ECHO_MAX_DURATION_MS);
	if (!Array.isArray(cues) || cues.length === 0) return cues;
	const keep = [];
	for (let i = 0; i < cues.length; i += 1) {
		const cur = cues[i];
		const duration = cur.endMs - cur.startMs;
		const isShort = duration < maxDurationMs;
		if (isShort) {
			// 检查是否是"回声":文本是某个相邻 cue 文本的子串(前一条或后一条)
			const neighbors = [];
			if (i > 0) neighbors.push(cues[i - 1]);
			if (i < cues.length - 1) neighbors.push(cues[i + 1]);
			const isEcho = neighbors.some((nb) => {
				const nbText = String(nb.text || "");
				const curText = String(cur.text || "");
				// 文本互为子串(回声通常是长cue的子串,也可能是反向)
				return curText && nbText && (nbText.includes(curText) || curText.includes(nbText));
			});
			if (isEcho) continue; // 跳过(删除回声)
		}
		keep.push(cur);
	}
	// 重新编号(去重后 index 连续)
	return keep.map((c, i) => ({ ...c, index: i + 1 }));
}

// ============================================================
// 合并短 cue:低于阈值且非回声的 cue 合并到时间上相邻的 cue
// ponytail: 短 cue(如 440ms 的 "Китайцы.")不适合独立显示,合并到邻近 cue。
// 优先合并到时间上紧邻的那侧(前 cue.end == 本 cue.start 或 本 cue.end == 后 cue.start)。
// 如果两侧都不紧邻,合并到前一条。
// ============================================================
export function mergeShortCues(cues, options = {}) {
	const maxDurationMs = Number(options.echoMaxDurationMs ?? ECHO_MAX_DURATION_MS);
	if (!Array.isArray(cues) || cues.length <= 1) return cues;
	const merged = [];
	let i = 0;
	while (i < cues.length) {
		const cur = cues[i];
		const duration = cur.endMs - cur.startMs;
		if (duration < maxDurationMs && merged.length > 0) {
			// 判断合并方向:看哪侧时间上紧邻
			const prev = merged[merged.length - 1];
			const next = i < cues.length - 1 ? cues[i + 1] : null;
			const contiguousWithPrev = Math.abs(cur.startMs - prev.endMs) < 10; // 10ms 容差
			const contiguousWithNext = next ? Math.abs(cur.endMs - next.startMs) < 10 : false;
			if (contiguousWithNext && !contiguousWithPrev) {
				// 只与后一条紧邻→合并到后一条(先把本 cue 存起来,下一轮处理)
				// 但更简单:把后一条拉长到包含本 cue
				// 不过这样会跳过本 cue 的文本。改用:先暂存,到后一条时合并。
				// 实际上最简洁的做法:本 cue 和后一条一起处理。
				// 这里采用:如果只与后一条紧邻,合并到后一条的起始时间。
				if (next) {
					cues[i + 1] = { ...next, startMs: cur.startMs, text: cur.text + " " + next.text };
					i += 1;
					continue;
				}
			}
			// 默认:合并到前一条
			merged[merged.length - 1] = { ...prev, endMs: Math.max(prev.endMs, cur.endMs), text: prev.text + " " + cur.text };
		} else {
			merged.push(cur);
		}
		i += 1;
	}
	return merged.map((c, idx) => ({ ...c, index: idx + 1 }));
}

// ============================================================
// 重排:把重叠时间改成首尾相接(滚动字幕的本质重叠)
// ponytail: endMs = min(本句end, 下句begin),保证单调不重叠。无副作用的标准算法。
// ============================================================
export function rerouteOverlap(cues) {
	if (!Array.isArray(cues) || cues.length === 0) return cues;
	return cues.map((c, i) => {
		const next = i < cues.length - 1 ? cues[i + 1] : null;
		// endMs 不超过下一句的开始;最后一句保持原值
		const endMs = next ? Math.min(c.endMs, next.startMs) : c.endMs;
		// 保证 endMs > startMs(重排不该产生零时长;若发生说明源数据严重病态,保留原值让 verify 抓)
		return { ...c, endMs: endMs > c.startMs ? endMs : c.endMs };
	});
}

// ============================================================
// SRT 格式化
// ============================================================
export function formatSrtTimestamp(ms) {
	const value = Math.max(0, Math.floor(ms));
	const hours = Math.floor(value / 3600000);
	const minutes = Math.floor((value % 3600000) / 60000);
	const seconds = Math.floor((value % 60000) / 1000);
	const millis = value % 1000;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function buildSrt(cues) {
	return cues.map((c, i) =>
		`${i + 1}\n${formatSrtTimestamp(c.startMs)} --> ${formatSrtTimestamp(c.endMs)}\n${c.text}\n`
	).join("\n").trim() + "\n";
}

// ============================================================
// 主流程纯函数(可单测,不碰 IO)
// ============================================================
export function cleanSubtitle(text, options = {}) {
	const { format, cues: parsed } = parseAnyFormat(text);
	// 顺序很重要:先去标记(已在解析时 cleanSubtitleText 完成)→ 去回声碎片 → 重排重叠
	let cues = parsed;
	cues = dedupeEchoes(cues, options);
	cues = mergeShortCues(cues, options);
	cues = rerouteOverlap(cues);
	// 再过滤一遍:清洗/去重/重排后可能产生空文本(原 marker-only)→ 丢
	cues = cues.filter((c) => c.text && c.text.trim()).map((c, i) => ({ ...c, index: i + 1 }));
	if (cues.length === 0) throw new Error("cleaning removed all cues (input may be marker-only)");
	const srt = buildSrt(cues);
	const stats = computeStats(cues);
	return { format, cues, srt, stats };
}

export function computeStats(cues) {
	let overlapCount = 0;
	let shortCount = 0;
	for (let i = 0; i < cues.length; i += 1) {
		const dur = cues[i].endMs - cues[i].startMs;
		if (dur < 500) shortCount++;
		if (i < cues.length - 1 && cues[i + 1].startMs < cues[i].endMs) overlapCount++;
	}
	return {
		cueCount: cues.length,
		overlapCount,
		shortCount,
		firstStartMs: cues[0]?.startMs ?? 0,
		lastEndMs: cues[cues.length - 1]?.endMs ?? 0,
	};
}

// ============================================================
// CLI
// ============================================================
export function parseCliArgs(argv) {
	const out = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) continue;
		const value = argv[index + 1];
		index += 1;
		switch (arg) {
			case "--subtitle": out.subtitlePath = value; break;
			case "--output-dir": out.outputDir = value; break;
			case "--echo-max-duration-ms": out.echoMaxDurationMs = Number(value); break;
			default: throw new Error(`Unknown flag: ${arg}`);
		}
	}
	return out;
}

function resolveInput(argv = process.argv.slice(2), env = process.env) {
	const cli = parseCliArgs(argv);
	const taskInput = (() => { try { return JSON.parse(env.TASK_INPUT || "{}"); } catch { return {}; } })();
	const outputDir = path.resolve(cli.outputDir || env.TASK_OUTPUT_DIR || taskInput.outputDir || "");
	if (!outputDir) throw new Error("TASK_OUTPUT_DIR or --output-dir is required");
	const subtitlePath = cli.subtitlePath || taskInput.subtitlePath;
	if (!subtitlePath) throw new Error("subtitlePath is required");
	const resolved = path.resolve(String(subtitlePath));
	if (!existsSync(resolved)) throw new Error(`subtitlePath does not exist: ${resolved}`);
	return {
		subtitlePath: resolved,
		outputDir,
		echoMaxDurationMs: cli.echoMaxDurationMs ?? taskInput.echoMaxDurationMs,
	};
}

async function main() {
	const input = resolveInput();
	await mkdir(input.outputDir, { recursive: true });
	const text = readFileSync(input.subtitlePath, "utf8");
	const result = cleanSubtitle(text, { echoMaxDurationMs: input.echoMaxDurationMs });
	const outputPath = path.join(input.outputDir, "cleaned.srt");
	await writeFile(outputPath, result.srt, "utf8");
	const report = {
		sourceSubtitlePath: input.subtitlePath,
		outputSubtitlePath: outputPath,
		format: result.format,
		...result.stats,
	};
	await writeFile(path.join(input.outputDir, "clean-report.json"), JSON.stringify(report, null, 2), "utf8");
	console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
