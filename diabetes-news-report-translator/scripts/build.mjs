import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const TRANSLATIONS_NAME = "translations.zh-CN.json";
const FINAL_NAME = "diabetes_news_report_pack.zh-CN.json";

function die(message) {
	console.error(message);
	process.exit(1);
}

function readInput() {
	let input;
	try {
		input = JSON.parse(process.env.TASK_INPUT || "{}");
	} catch (error) {
		die(`TASK_INPUT is not valid JSON: ${error.message}`);
	}
	if (!input.packPath) die("TASK_INPUT.packPath is required");
	if (input.targetLanguage !== "zh-CN") die("Only targetLanguage=zh-CN is supported");
	return {
		packPath: resolve(String(input.packPath)),
		targetLanguage: "zh-CN",
	};
}

function pickText(item, ...keys) {
	for (const key of keys) {
		if (typeof item[key] === "string" && item[key].trim()) return item[key].trim();
	}
	return "";
}

const input = readInput();
const outputDir = process.env.TASK_OUTPUT_DIR || die("TASK_OUTPUT_DIR is required");
const pack = JSON.parse(await readFile(input.packPath, "utf8"));
const translations = JSON.parse(await readFile(join(outputDir, TRANSLATIONS_NAME), "utf8"));
if (translations.targetLanguage !== "zh-CN") die("translations.zh-CN.json targetLanguage must be zh-CN");
if (!Array.isArray(translations.items)) die("translations.zh-CN.json items must be an array");

const byId = new Map(translations.items.map((item) => [item.itemId, item]));
const items = pack.items.map((item) => {
	const translated = byId.get(item.itemId);
	if (!translated) die(`Missing translation for ${item.itemId}`);
	return {
		...item,
		translatedTitle: pickText(translated, "translatedTitle", "title"),
		translatedSummary: pickText(translated, "translatedSummary", "summary"),
	};
});

for (const item of items) {
	if (!item.translatedTitle || !item.translatedSummary) die(`Empty translation for ${item.itemId}`);
}

const translatedPack = {
	...pack,
	task: "diabetes-news-report-translator",
	sourceTask: "diabetes-news-report-packager",
	sourcePackPath: input.packPath,
	targetLanguage: "zh-CN",
	translatedAt: new Date().toISOString(),
	translatedTitle: pickText(translations, "translatedTitle", "reportTitle") || pack.title || "",
	items,
};

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, FINAL_NAME), `${JSON.stringify(translatedPack, null, 2)}\n`, "utf8");
console.log(`Wrote translated pack to ${join(outputDir, FINAL_NAME)}`);
