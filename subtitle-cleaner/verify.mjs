import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { hasSubtitleMarker, parseSubtitleText } from "./scripts/clean-subtitle.mjs";

const outputDir = process.env.TASK_OUTPUT_DIR;
const failures = [];

function fail(assertion, expected, actual, hint) {
	failures.push({ assertion, expected, actual, ...(hint ? { hint } : {}) });
}

function readText(name) {
	const filePath = join(outputDir, name);
	if (!existsSync(filePath)) {
		fail(`${name} exists`, "file exists", "missing", filePath);
		return "";
	}
	return readFileSync(filePath, "utf8");
}

function readJson(name) {
	const text = readText(name);
	if (!text) return undefined;
	try {
		return JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		fail(`${name} is valid JSON`, "parseable JSON", error.message);
		return undefined;
	}
}

if (!outputDir || !existsSync(outputDir)) {
	fail("TASK_OUTPUT_DIR exists", "existing output directory", outputDir || "missing");
} else {
	const srtText = readText("cleaned.srt");
	let cues;
	if (srtText) {
		// 1. 音效标记检查
		if (hasSubtitleMarker(srtText)) {
			fail("cleaned.srt no sound-effect markers", "no short bracket marker", "found");
		}
		// 2. 可解析为合法 SRT
		try {
			cues = parseSubtitleText(srtText);
			if (cues.length === 0) {
				fail("cleaned.srt has cues", "cue count > 0", "0");
			}
		} catch (error) {
			fail("cleaned.srt parses", "parseable SRT", error.message);
		}
		// 3. 无重叠 + 无短 cue(<500ms)
		if (cues && cues.length > 0) {
			for (let i = 0; i < cues.length; i += 1) {
				const dur = cues[i].endMs - cues[i].startMs;
				if (dur < 500) {
					fail(`cleaned.srt cue ${i + 1} duration`, ">= 500ms", `${dur}ms`, "echo fragment not deduped");
				}
				if (i < cues.length - 1 && cues[i + 1].startMs < cues[i].endMs) {
					fail(`cleaned.srt cue ${i + 1} overlap`, `startMs >= ${cues[i].endMs}`, `${cues[i + 1].startMs}`, "overlap not rerouted");
				}
			}
			// 4. 非空文本
			const emptyText = cues.find((c) => !c.text || !c.text.trim());
			if (emptyText) {
				fail("cleaned.srt cue text non-empty", "non-empty text", JSON.stringify(emptyText.text));
			}
		}
	}

	// 5. clean-report.json 完整性
	const report = readJson("clean-report.json");
	if (report) {
		if (!report.sourceSubtitlePath) fail("clean-report.sourceSubtitlePath", "non-empty", JSON.stringify(report.sourceSubtitlePath));
		if (!report.outputSubtitlePath || !existsSync(report.outputSubtitlePath)) {
			fail("clean-report.outputSubtitlePath exists", "existing file", JSON.stringify(report.outputSubtitlePath));
		}
		if (!report.format) fail("clean-report.format", "non-empty", JSON.stringify(report.format));
		if (!["ttml", "vtt", "srt"].includes(String(report.format))) {
			fail("clean-report.format canonical", "ttml|vtt|srt", JSON.stringify(report.format));
		}
		if (!Number.isFinite(Number(report.cueCount)) || Number(report.cueCount) <= 0) {
			fail("clean-report.cueCount", "positive number", JSON.stringify(report.cueCount));
		}
		if (Number(report.overlapCount) !== 0) {
			fail("clean-report.overlapCount", "0 (cleaned srt must have no overlap)", JSON.stringify(report.overlapCount));
		}
		// 短 cue 数也应为 0(回声碎片已去重)
		if (Number(report.shortCount) !== 0) {
			fail("clean-report.shortCount", "0 (echo fragments deduped)", JSON.stringify(report.shortCount));
		}
		// 一致性:report.cueCount 应等于实际解析的 cue 数
		if (cues && Number(report.cueCount) !== cues.length) {
			fail("clean-report.cueCount matches cleaned.srt", String(cues.length), String(report.cueCount));
		}
	}
}

if (failures.length > 0) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
process.exit(0);
