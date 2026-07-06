import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PACK_NAME = "diabetes_news_report_pack.json";
const DEVICE_TEXT = /diabetes|diabetic|glucose|cgm|continuous glucose|insulin pump|automated insulin|closed[- ]loop|artificial pancreas|bionic pancreas|dexcom|freestyle libre|\blibre\b|omnipod|insulet|eversense|minimed|tandem|control-iq|mobi|ilet|twiist|sensor|wearable/i;

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
	const paths = Array.isArray(input.inputPaths) ? input.inputPaths : [input.inputPaths].filter(Boolean);
	if (!paths.length) die("TASK_INPUT.inputPaths is required");
	return {
		inputPaths: paths.map((item) => String(item)),
		maxItems: Math.min(500, Math.max(1, Number(input.maxItems || 300))),
		title: String(input.title || "").trim(),
	};
}

function shortText(value, max = 420) {
	const text = String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3).trimEnd()}...`;
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

function itemId(url) {
	return `item-${createHash("sha1").update(url).digest("hex").slice(0, 12)}`;
}

async function expandInputPaths(paths) {
	const files = [];
	for (const rawPath of paths) {
		const fullPath = resolve(rawPath);
		let info;
		try {
			info = await stat(fullPath);
		} catch {
			die(`Input path does not exist: ${rawPath}`);
		}
		if (info.isDirectory()) {
			for (const entry of await readdir(fullPath)) {
				if (entry.toLowerCase().endsWith(".json")) files.push(join(fullPath, entry));
			}
		} else {
			files.push(fullPath);
		}
	}
	return [...new Set(files)].sort();
}

async function readCollectorJson(file) {
	let data;
	try {
		data = JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		die(`Cannot parse JSON ${file}: ${error.message}`);
	}
	if (!data || typeof data !== "object" || !Array.isArray(data.results)) die(`Input is not a compatible collector JSON: ${file}`);
	return { file, data };
}

function normalizeItem(doc, item) {
	const sourceTask = String(doc.task || "");
	const regulatory = sourceTask === "diabetes-device-regulatory-signals" || "signalType" in item;
	const date = dateIso(item.publishedAt || item.date);
	const url = normalizeUrl(item.url);
	const title = shortText(item.title || item.id || url, 260);
	if (!date || !url || !title) return null;
	const context = shortText(item.context || item.feedExcerpt || "");
	const company = shortText(item.company || "", 160);
	const deviceOrProduct = shortText(item.deviceOrProduct || "", 180);
	const summary = regulatory
		? shortText([deviceOrProduct, company, context].filter(Boolean).join("; "))
		: shortText(item.feedExcerpt || "");
	const deviceRelated = regulatory || item.isDeviceRelated === true || DEVICE_TEXT.test(`${title}\n${summary}`);
	return {
		itemId: itemId(url),
		sourceTask,
		source: String(item.source || sourceTask || "Unknown"),
		type: regulatory ? String(item.signalType || "regulatory") : (deviceRelated ? "device-news" : "diabetes-news"),
		date,
		title,
		summary,
		url,
		company,
		deviceOrProduct,
		priority: regulatory ? 3 : (deviceRelated ? 2 : 1),
	};
}

function normalizeStatus(doc, status) {
	return {
		sourceTask: String(doc.task || ""),
		source: String(status.source || status.name || "Unknown"),
		mode: String(status.mode || status.signalType || status.filter || ""),
		ok: status.ok === true,
		itemCount: Number(status.itemCount || status.total || 0),
		matchedCount: Number(status.matchedCount || 0),
		queryUrl: String(status.queryUrl || status.feedUrl || ""),
		error: String(status.error || status.note || ""),
	};
}

function buildPack(docs, files, input) {
	const byUrl = new Map();
	const sourceStatus = [];
	let totalInputItems = 0;
	for (const { data } of docs) {
		for (const status of data.sourceStatus || []) sourceStatus.push(normalizeStatus(data, status));
		for (const rawItem of data.results || []) {
			totalInputItems += 1;
			const item = normalizeItem(data, rawItem);
			if (!item) continue;
			const key = normalizeUrl(item.url);
			const prev = byUrl.get(key);
			if (!prev || item.priority > prev.priority || (item.priority === prev.priority && item.date > prev.date)) byUrl.set(key, item);
		}
	}
	const items = [...byUrl.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, input.maxItems);
	const highlights = [...items]
		.sort((a, b) => (b.priority - a.priority) || b.date.localeCompare(a.date))
		.slice(0, 8)
		.map((item) => item.itemId);
	return {
		task: "diabetes-news-report-packager",
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		title: input.title,
		sourceFiles: files,
		inputTasks: [...new Set(docs.map((doc) => String(doc.data.task || "")).filter(Boolean))],
		summary: {
			totalInputItems,
			totalDedupedItems: byUrl.size,
			totalPackedItems: items.length,
			deviceOrRegulatoryItems: items.filter((item) => item.priority >= 2).length,
			totalSources: sourceStatus.length,
			successfulSources: sourceStatus.filter((item) => item.ok).length,
		},
		items,
		highlights,
		sourceStatus,
	};
}

const input = readInput();
const outputDir = process.env.TASK_OUTPUT_DIR || die("TASK_OUTPUT_DIR is required");
const files = await expandInputPaths(input.inputPaths);
if (!files.length) die("No JSON files found in inputPaths");
const docs = await Promise.all(files.map(readCollectorJson));
const pack = buildPack(docs, files, input);

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, PACK_NAME), `${JSON.stringify(pack, null, 2)}\n`, "utf8");
console.log(`Wrote ${pack.items.length} packed items to ${join(outputDir, PACK_NAME)}`);
