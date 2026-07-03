import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { defaultMaxUnitChars, hasCjk, hasSubtitleMarker, parseSubtitleText, validateUnits } from "./scripts/make-fluent-subtitle.mjs";

const outputDir = process.env.TASK_OUTPUT_DIR;
const taskInput = JSON.parse(process.env.TASK_INPUT || "{}");
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

function isVerbosity(value) {
	return ["normal", "talkative"].includes(String(value || "normal"));
}

function numberOrUndefined(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : undefined;
}

if (!outputDir || !existsSync(outputDir)) {
	fail("TASK_OUTPUT_DIR exists", "existing output directory", outputDir || "missing");
} else {
	const sourceCues = readJson("source.cues.json");
	const units = readJson("fluent.units.json");
	if (units && hasSubtitleMarker(JSON.stringify(units))) {
		fail("fluent.units.json short bracket noise markers", "no short bracket noise marker", "found", "remove non-speech bracket markers before writing fluent.units.json");
	}
	let normalized;
	if (Array.isArray(sourceCues) && sourceCues.length > 0 && units) {
		try {
			normalized = validateUnits(sourceCues, units, {
				targetLanguage: taskInput.targetLanguage || "zh-CN",
				verbosity: taskInput.verbosity || "normal",
				maxUnitDurationMs: taskInput.maxUnitDurationMs || 8000,
				maxUnitChars: taskInput.maxUnitChars || defaultMaxUnitChars(taskInput.verbosity),
			});
		} catch (error) {
			fail("fluent.units.json covers source cues", "ordered complete ids with valid text", error.message);
		}
	} else if (Array.isArray(sourceCues)) {
		fail("source.cues.json has cues", "cue count > 0", String(sourceCues.length));
	}

	const srtText = readText("fluent.zh.srt");
	let outputCues;
	if (srtText) {
		if (hasSubtitleMarker(srtText)) {
			fail("fluent.zh.srt short bracket noise markers", "no short bracket noise marker", "found");
		}
		try {
			outputCues = parseSubtitleText(srtText);
			if (String(taskInput.targetLanguage || "zh-CN").toLowerCase().startsWith("zh") && !hasCjk(srtText)) {
				fail("fluent.zh.srt contains Chinese", "CJK text", "no CJK text");
			}
			const shortCue = outputCues.find((cue) => cue.endMs - cue.startMs < 500);
			if (shortCue) {
				fail("fluent.zh.srt cue duration", "all cues >= 500ms", `${shortCue.endMs - shortCue.startMs}ms`);
			}
			const videoDurationSeconds = numberOrUndefined(taskInput.videoDurationSeconds);
			if (videoDurationSeconds !== undefined && outputCues.at(-1)?.endMs > Math.round(videoDurationSeconds * 1000)) {
				fail("fluent.zh.srt within video duration", `<= ${Math.round(videoDurationSeconds * 1000)}ms`, `${outputCues.at(-1)?.endMs}ms`);
			}
		} catch (error) {
			fail("fluent.zh.srt parses", "parseable SRT", error.message);
		}
	}
	if (normalized && outputCues) {
		if (outputCues.length !== normalized.length) {
			fail("fluent.zh.srt cue count", String(normalized.length), String(outputCues.length));
		}
		let prevExpectedEndMs = 0;
		for (let index = 0; index < Math.min(outputCues.length, normalized.length); index += 1) {
			const expected = normalized[index];
			const actual = outputCues[index];
			const expectedStartMs = Math.max(expected.startMs, prevExpectedEndMs);
			const expectedEndMs = Math.max(expected.endMs, expectedStartMs);
			prevExpectedEndMs = expectedEndMs;
			if (actual.startMs !== expectedStartMs || actual.endMs !== expectedEndMs) {
				fail(`fluent.zh.srt cue ${index + 1} timing`, `${expectedStartMs}-${expectedEndMs}`, `${actual.startMs}-${actual.endMs}`);
			}
			if (index > 0 && actual.startMs < outputCues[index - 1].endMs) {
				fail(`fluent.zh.srt cue ${index + 1} monotonic`, "no overlap", `${actual.startMs} < ${outputCues[index - 1].endMs}`);
			}
		}
	}

	const report = readJson("fluent-report.json");
	if (report) {
		if (!isVerbosity(taskInput.verbosity)) {
			fail("taskInput.verbosity", "normal|talkative", JSON.stringify(taskInput.verbosity));
		}
		if (sourceCues && Number(report.sourceCueCount) !== sourceCues.length) {
			fail("fluent-report.sourceCueCount", String(sourceCues.length), String(report.sourceCueCount));
		}
		if (normalized && Number(report.unitCount) !== normalized.length) {
			fail("fluent-report.unitCount", String(normalized.length), String(report.unitCount));
		}
		if (report.verbosity && !["normal", "talkative"].includes(String(report.verbosity))) {
			fail("fluent-report.verbosity canonical", "normal|talkative", JSON.stringify(report.verbosity));
		}
		if (taskInput.verbosity && String(report.verbosity) !== String(taskInput.verbosity)) {
			fail("fluent-report.verbosity", String(taskInput.verbosity), JSON.stringify(report.verbosity));
		}
		if (taskInput.glossary && String(report.glossary || "") !== String(taskInput.glossary)) {
			fail("fluent-report.glossary", String(taskInput.glossary), JSON.stringify(report.glossary || ""));
		}
		if (taskInput.referenceSubtitlePath) {
			if (String(report.referenceSubtitlePath || "") !== String(taskInput.referenceSubtitlePath)) {
				fail("fluent-report.referenceSubtitlePath", String(taskInput.referenceSubtitlePath), JSON.stringify(report.referenceSubtitlePath || ""));
			}
			const referenceCues = readJson("reference.cues.json");
			if (!Array.isArray(referenceCues) || referenceCues.length === 0) {
				fail("reference.cues.json cue count", "cue count > 0", JSON.stringify(referenceCues?.length));
			}
		}
		if (taskInput.videoDurationSeconds && Number(report.videoDurationSeconds) !== Number(taskInput.videoDurationSeconds)) {
			fail("fluent-report.videoDurationSeconds", String(taskInput.videoDurationSeconds), JSON.stringify(report.videoDurationSeconds));
		}
		if (!report.outputSubtitlePath || !existsSync(report.outputSubtitlePath)) {
			fail("fluent-report.outputSubtitlePath exists", "existing output subtitle", JSON.stringify(report.outputSubtitlePath));
		}
	}
}

if (failures.length > 0) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
process.exit(0);
