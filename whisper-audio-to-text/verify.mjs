import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
	if (statSync(filePath).size === 0) fail(`${name} non-empty`, "> 0 bytes", "0 bytes");
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
	const txt = readText("transcript.txt");
	if (txt && !txt.trim()) fail("transcript.txt has text", "non-whitespace text", "blank");
	const srt = readText("transcript.srt");
	if (srt && !/\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/.test(srt)) {
		fail("transcript.srt has timecodes", "SRT timecode", "missing");
	}
	const vtt = readText("transcript.vtt");
	if (vtt && !vtt.includes("WEBVTT")) fail("transcript.vtt has header", "WEBVTT", "missing");
	const transcription = readJson("transcription.json");
	if (transcription) {
		const hasText = typeof transcription.text === "string" && transcription.text.trim().length > 0;
		const hasSegments = Array.isArray(transcription.segments) && transcription.segments.length > 0;
		if (!hasText && !hasSegments) fail("transcription.json content", "non-empty text or segments", "missing");
	}
	const summary = readJson("whisper-summary.json");
	if (summary) {
		for (const field of ["inputFilePath", "model", "modelDir", "language", "task", "transcriptTextPath", "transcriptSrtPath", "transcriptVttPath", "transcriptionJsonPath"]) {
			if (!summary[field]) fail(`whisper-summary.${field}`, "non-empty value", JSON.stringify(summary[field]));
		}
		if (summary.modelDir && !String(summary.modelDir).startsWith("E:\\")) {
			fail("whisper-summary.modelDir on E drive", "E:\\...", summary.modelDir);
		}
		for (const field of ["transcriptTextPath", "transcriptSrtPath", "transcriptVttPath", "transcriptionJsonPath"]) {
			if (summary[field] && !existsSync(summary[field])) fail(`whisper-summary.${field} exists`, "existing file", JSON.stringify(summary[field]));
		}
	}
}

if (failures.length > 0) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
process.exit(0);
