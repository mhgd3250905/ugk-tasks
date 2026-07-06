import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PACK_NAME = "diabetes_news_report_pack.json";
const FORBIDDEN_ARTIFACTS = ["diabetes_news_report.html", "diabetes_news_report_pack.zh-CN.json", "diabetes_news_report.md"];

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

function normalizeUrl(value) {
	try {
		const url = new URL(String(value || ""));
		url.hash = "";
		return url.href.replace(/\/$/, "");
	} catch {
		return String(value || "").trim();
	}
}

function dateIso(value) {
	const raw = String(value || "").trim();
	const ms = Date.parse(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function expandInputPaths(paths) {
	const files = [];
	for (const rawPath of paths) {
		const fullPath = resolve(rawPath);
		if (!existsSync(fullPath)) {
			fail("input path exists", rawPath, "missing");
			continue;
		}
		const info = statSync(fullPath);
		if (info.isDirectory()) {
			for (const entry of readdirSync(fullPath)) {
				if (entry.toLowerCase().endsWith(".json")) files.push(join(fullPath, entry));
			}
		} else {
			files.push(fullPath);
		}
	}
	return [...new Set(files)].sort();
}

function normalizeInputItem(doc, item) {
	const date = dateIso(item.publishedAt || item.date);
	const url = normalizeUrl(item.url);
	const title = String(item.title || item.id || "").trim();
	if (!date || !url || !title) return null;
	const regulatory = doc.task === "diabetes-device-regulatory-signals" || "signalType" in item;
	return {
		date,
		url,
		priority: regulatory ? 3 : (item.isDeviceRelated === true ? 2 : 1),
	};
}

function expectedItems(docs, maxItems) {
	const byUrl = new Map();
	for (const doc of docs) {
		for (const rawItem of doc.results || []) {
			const item = normalizeInputItem(doc, rawItem);
			if (!item) continue;
			const prev = byUrl.get(item.url);
			if (!prev || item.priority > prev.priority || (item.priority === prev.priority && item.date > prev.date)) byUrl.set(item.url, item);
		}
	}
	return [...byUrl.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, maxItems);
}

const outDir = process.env.TASK_OUTPUT_DIR || ".";
const input = parseJson(process.env.TASK_INPUT || "{}", "TASK_INPUT") || {};
const inputPaths = Array.isArray(input.inputPaths) ? input.inputPaths : [input.inputPaths].filter(Boolean);
const maxItems = Math.min(500, Math.max(1, Number(input.maxItems || 300)));
const packPath = join(outDir, PACK_NAME);

if (!inputPaths.length) fail("TASK_INPUT.inputPaths is required", "non-empty array", input.inputPaths);
if (!existsSync(packPath)) fail("pack artifact exists", PACK_NAME, "missing");
for (const name of FORBIDDEN_ARTIFACTS) {
	if (existsSync(join(outDir, name))) fail("packager emits pack JSON only", `no ${name}`, "present");
}

const files = expandInputPaths(inputPaths);
const docs = files.map((file) => parseJson(readFileSync(file, "utf8"), file)).filter(Boolean);
const expected = expectedItems(docs, maxItems);

if (existsSync(packPath)) {
	const pack = parseJson(readFileSync(packPath, "utf8"), PACK_NAME);
	if (pack) {
		if (pack.task !== "diabetes-news-report-packager") fail("pack task is correct", "diabetes-news-report-packager", pack.task);
		if (pack.schemaVersion !== 1) fail("pack schemaVersion is stable", 1, pack.schemaVersion);
		if (!Array.isArray(pack.items)) fail("pack.items is array", "array", typeof pack.items);
		if (!Array.isArray(pack.highlights)) fail("pack.highlights is array", "array", typeof pack.highlights);
		if (!Array.isArray(pack.sourceStatus)) fail("pack.sourceStatus is array", "array", typeof pack.sourceStatus);
		if (!Array.isArray(pack.sourceFiles) || pack.sourceFiles.length !== files.length) fail("pack.sourceFiles records all inputs", files.length, pack.sourceFiles);
		if (String(pack.title || "") !== String(input.title || "")) fail("pack carries report title", input.title || "", pack.title || "");
		if (Array.isArray(pack.items)) {
			if (pack.items.length !== expected.length) fail("pack item count equals deduped and truncated input", expected.length, pack.items.length);
			if (pack.items.length > maxItems) fail("pack respects maxItems", `<= ${maxItems}`, pack.items.length);
			const seenUrls = new Set();
			let lastDate = "9999";
			for (const [index, item] of pack.items.entries()) {
				for (const field of ["itemId", "date", "source", "type", "title", "summary", "url", "priority"]) {
					if (!(field in item)) fail(`items[${index}] has field ${field}`, "present", "missing");
				}
				const url = normalizeUrl(item.url);
				if (seenUrls.has(url)) fail(`items[${index}].url is unique`, "unique URL", item.url);
				seenUrls.add(url);
				if (item.date > lastDate) fail("items are newest first", "descending date", { index, date: item.date, previous: lastDate });
				lastDate = item.date;
				if (expected[index] && url !== expected[index].url) fail(`items[${index}] matches expected dedupe order`, expected[index].url, item.url);
			}
		}
		if (Array.isArray(pack.highlights) && Array.isArray(pack.items)) {
			const itemIds = new Set(pack.items.map((item) => item.itemId));
			for (const id of pack.highlights) if (!itemIds.has(id)) fail("highlight itemId exists in items", "known itemId", id);
			const highlightItems = pack.highlights.map((id) => pack.items.find((item) => item.itemId === id)).filter(Boolean);
			if (highlightItems.length > 8) fail("highlights are capped", "<= 8", highlightItems.length);
			let sawLowerPriority = false;
			for (const item of highlightItems) {
				if (Number(item.priority) < 2) sawLowerPriority = true;
				if (sawLowerPriority && Number(item.priority) >= 2) fail("highlights prioritize device/regulatory items", "priority >=2 before lower priority", item);
			}
		}
	}
}

if (failures.length) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
