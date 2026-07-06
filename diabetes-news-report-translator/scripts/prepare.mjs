import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const UNITS_NAME = "translation_units.json";

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

const input = readInput();
const outputDir = process.env.TASK_OUTPUT_DIR || die("TASK_OUTPUT_DIR is required");
const pack = JSON.parse(await readFile(input.packPath, "utf8"));
if (!Array.isArray(pack.items)) die("pack.items must be an array");

const units = {
	task: "diabetes-news-report-translator",
	sourcePackPath: input.packPath,
	targetLanguage: input.targetLanguage,
	reportTitle: String(pack.title || ""),
	items: pack.items.map((item) => ({
		itemId: item.itemId,
		type: item.type,
		title: item.title,
		summary: item.summary,
		company: item.company || "",
		deviceOrProduct: item.deviceOrProduct || "",
		source: item.source,
		date: item.date,
		url: item.url,
	})),
};

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, UNITS_NAME), `${JSON.stringify(units, null, 2)}\n`, "utf8");
console.log(`Wrote ${units.items.length} translation units to ${join(outputDir, UNITS_NAME)}`);
