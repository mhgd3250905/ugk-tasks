import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FINAL_NAME = "diabetes_news_report_pack.zh-CN.json";
const UNITS_NAME = "translation_units.json";
const TRANSLATIONS_NAME = "translations.zh-CN.json";
const FORBIDDEN_ARTIFACTS = ["diabetes_news_report.html", "diabetes_news_report.md"];

const failures = [];
function fail(assertion, expected, actual) {
	failures.push({ assertion, expected, actual });
}

function parseJson(text, label) {
	try {
		return JSON.parse(text);
	} catch (error) {
		fail(`${label} is valid JSON`, "parseable JSON", error.message || String(error));
		return null;
	}
}

function cjkCount(text) {
	return (String(text || "").match(/[\u4e00-\u9fff]/g) || []).length;
}

function englishHeavy(text) {
	const value = String(text || "");
	return cjkCount(value) === 0 && /[A-Za-z]{3,}/.test(value) && value.length >= 16;
}

function hasLongSourceLeak(source, translated) {
	const normalized = String(translated || "").toLowerCase();
	return String(source || "")
		.split(/[.;:!?()\[\]{}，。；：！？、]/)
		.map((part) => part.replace(/\s+/g, " ").trim())
		.filter((part) => part.length >= 36 && /[A-Za-z]{3,}/.test(part))
		.some((part) => normalized.includes(part.toLowerCase()));
}

const outDir = process.env.TASK_OUTPUT_DIR || ".";
const input = parseJson(process.env.TASK_INPUT || "{}", "TASK_INPUT") || {};
const packPath = input.packPath ? resolve(String(input.packPath)) : "";
const finalPath = join(outDir, FINAL_NAME);

if (input.targetLanguage !== "zh-CN") fail("targetLanguage is supported", "zh-CN", input.targetLanguage);
if (!packPath) fail("TASK_INPUT.packPath is required", "path", input.packPath);
if (packPath && !existsSync(packPath)) fail("input pack exists", packPath, "missing");
for (const name of [UNITS_NAME, TRANSLATIONS_NAME, FINAL_NAME]) {
	if (!existsSync(join(outDir, name))) fail(`${name} exists`, name, "missing");
}
for (const name of FORBIDDEN_ARTIFACTS) {
	if (existsSync(join(outDir, name))) fail("translator does not render HTML/MD", `no ${name}`, "present");
}

const sourcePack = packPath && existsSync(packPath) ? parseJson(readFileSync(packPath, "utf8"), "source pack") : null;
const finalPack = existsSync(finalPath) ? parseJson(readFileSync(finalPath, "utf8"), FINAL_NAME) : null;
const translations = existsSync(join(outDir, TRANSLATIONS_NAME)) ? parseJson(readFileSync(join(outDir, TRANSLATIONS_NAME), "utf8"), TRANSLATIONS_NAME) : null;

if (sourcePack && finalPack) {
	if (finalPack.task !== "diabetes-news-report-translator") fail("translated pack task is correct", "diabetes-news-report-translator", finalPack.task);
	if (finalPack.sourceTask !== "diabetes-news-report-packager") fail("translated pack records source task", "diabetes-news-report-packager", finalPack.sourceTask);
	if (finalPack.targetLanguage !== "zh-CN") fail("translated pack targetLanguage", "zh-CN", finalPack.targetLanguage);
	if (!Array.isArray(finalPack.items) || !Array.isArray(sourcePack.items)) {
		fail("translated and source items are arrays", "arrays", { source: typeof sourcePack.items, final: typeof finalPack.items });
	} else {
		if (finalPack.items.length !== sourcePack.items.length) fail("translator preserves item count", sourcePack.items.length, finalPack.items.length);
		const sourceById = new Map(sourcePack.items.map((item) => [item.itemId, item]));
		for (const [index, item] of finalPack.items.entries()) {
			const source = sourceById.get(item.itemId);
			if (!source) {
				fail(`items[${index}].itemId comes from source pack`, "known itemId", item.itemId);
				continue;
			}
			for (const field of ["url", "date", "source", "type", "title", "summary"]) {
				if (item[field] !== source[field]) fail(`items[${index}] preserves ${field}`, source[field], item[field]);
			}
			for (const field of ["translatedTitle", "translatedSummary"]) {
				if (typeof item[field] !== "string" || !item[field].trim()) fail(`items[${index}] has ${field}`, "non-empty string", item[field]);
			}
			if (englishHeavy(source.title)) {
				if (cjkCount(item.translatedTitle) < 6) fail(`items[${index}].translatedTitle is readable Chinese`, ">= 6 CJK chars", item.translatedTitle);
				if (hasLongSourceLeak(source.title, item.translatedTitle)) fail(`items[${index}].translatedTitle does not keep full English sentence`, "translated text", item.translatedTitle);
			}
			if (englishHeavy(source.summary)) {
				if (cjkCount(item.translatedSummary) < 8) fail(`items[${index}].translatedSummary is readable Chinese`, ">= 8 CJK chars", item.translatedSummary);
				if (hasLongSourceLeak(source.summary, item.translatedSummary)) fail(`items[${index}].translatedSummary does not keep full English sentence`, "translated text", item.translatedSummary);
			}
		}
	}
}

if (translations && finalPack) {
	if (translations.targetLanguage !== "zh-CN") fail("translations targetLanguage", "zh-CN", translations.targetLanguage);
	if (!Array.isArray(translations.items)) fail("translations.items is array", "array", typeof translations.items);
}

if (failures.length) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
