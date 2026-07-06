import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const JSON_NAME = "diabetes_device_custom_source_news.json";
const FORBIDDEN_ARTIFACTS = ["diabetes_device_custom_source_news.md", "diabetes_device_custom_source_news.html"];
const SOURCE_DOMAINS = {
	"Sequel Med Tech": /^https:\/\/www\.sequelmedtech\.com\//,
	"Senseonics": /^https:\/\/www\.senseonics\.com\//,
	"Dexcom IR": /^https:\/\/investors\.dexcom\.com\//,
	"Insulet IR": /^https:\/\/investors\.insulet\.com\//,
	"MassDevice": /^https:\/\/www\.massdevice\.com\//,
	"MobiHealthNews": /^https:\/\/www\.mobihealthnews\.com\//,
};
const REQUIRED_FILTERS = new Set(["sequel", "senseonics", "dexcom", "insulet", "massdevice", "mobihealthnews"]);
const STABLE_FILTERS = new Set(["sequel", "senseonics"]);
const CDP_RECOVERED_FILTERS = new Set(["dexcom", "insulet", "massdevice"]);

const failures = [];
function fail(assertion, expected, actual) {
	if (typeof expected !== "string") expected = JSON.stringify(expected);
	if (typeof actual !== "string") actual = JSON.stringify(actual);
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

function isObject(value) {
	return value && typeof value === "object" && !Array.isArray(value);
}

function parseTime(value, label) {
	const ms = Date.parse(String(value || ""));
	if (!Number.isFinite(ms)) fail(`${label} is parseable datetime`, "valid datetime", value);
	return ms;
}

const outDir = process.env.TASK_OUTPUT_DIR || ".";
const input = parseJson(process.env.TASK_INPUT || "{}", "TASK_INPUT") || {};
const jsonPath = join(outDir, JSON_NAME);

if (!existsSync(jsonPath)) fail("JSON artifact exists", JSON_NAME, "missing");
for (const name of FORBIDDEN_ARTIFACTS) {
	if (existsSync(join(outDir, name))) fail("collector emits JSON only", `no ${name}`, "present");
}

const startMs = parseTime(input.startIso, "TASK_INPUT.startIso");
const endMs = parseTime(input.endIso, "TASK_INPUT.endIso");
if (Number.isFinite(startMs) && Number.isFinite(endMs) && !(startMs < endMs)) fail("TASK_INPUT.startIso is before endIso", "start < end", { startIso: input.startIso, endIso: input.endIso });

if (existsSync(jsonPath)) {
	const data = parseJson(readFileSync(jsonPath, "utf8"), JSON_NAME);
	if (data) {
		for (const field of ["task", "retrievedAt", "timeWindow", "sources", "sourceStatus", "summary", "results"]) {
			if (!(field in data)) fail(`output has field ${field}`, "present", "missing");
		}
		if ("outputLanguage" in data) fail("collector output is language-neutral", "no outputLanguage field", data.outputLanguage);
		if (data.task !== "diabetes-device-custom-source-news") fail("task name is correct", "diabetes-device-custom-source-news", data.task);
		parseTime(data.retrievedAt, "retrievedAt");

		if (!isObject(data.timeWindow)) {
			fail("timeWindow is object", "object", data.timeWindow);
		} else {
			if (String(data.timeWindow.raw || "") !== String(input.timePhrase || "")) fail("timeWindow.raw matches input", input.timePhrase, data.timeWindow.raw);
			if (Number(data.timeWindow.days) !== Number(input.days)) fail("timeWindow.days matches input", input.days, data.timeWindow.days);
			if (String(data.timeWindow.startIso) !== new Date(startMs).toISOString()) fail("timeWindow.startIso matches input", input.startIso, data.timeWindow.startIso);
			if (String(data.timeWindow.endIso) !== new Date(endMs).toISOString()) fail("timeWindow.endIso matches input", input.endIso, data.timeWindow.endIso);
		}

		if (!Array.isArray(data.sources)) {
			fail("sources is array", "Array", typeof data.sources);
		} else {
			const filters = new Set(data.sources.map((item) => item?.filter));
			for (const filter of REQUIRED_FILTERS) {
				if (!filters.has(filter)) fail("sources include phase 3 custom/CDP source", filter, [...filters]);
			}
		}

		if (!Array.isArray(data.sourceStatus) || data.sourceStatus.length !== data.sources?.length) {
			fail("sourceStatus has one row per source", data.sources?.length, data.sourceStatus?.length);
		} else {
			const byFilter = new Map(data.sourceStatus.map((item) => [item?.filter, item]));
			for (const filter of REQUIRED_FILTERS) {
				if (!byFilter.has(filter)) fail("sourceStatus includes phase 3 source", filter, [...byFilter.keys()]);
			}
			const stableOk = [...STABLE_FILTERS].filter((filter) => byFilter.get(filter)?.ok === true).length;
			if (stableOk < 1) fail("at least one stable custom source is reachable", ">= 1 stable ok", stableOk);
			const cdpWithItems = [...CDP_RECOVERED_FILTERS].filter((filter) => {
				const row = byFilter.get(filter);
				return row?.ok === true && Number(row?.itemCount || 0) >= 1;
			}).length;
			if (cdpWithItems < 1) fail("at least one CDP recovered source has parseable listing items", ">= 1 CDP source with items", cdpWithItems);
		}

		if (!Array.isArray(data.results)) {
			fail("results is array", "Array", typeof data.results);
		} else {
			const seen = new Set();
			let lastTime = Infinity;
			for (const [index, item] of data.results.entries()) {
				if (!isObject(item)) {
					fail(`results[${index}] is object`, "object", item);
					continue;
				}
				for (const field of ["source", "title", "publishedAt", "url", "feedExcerpt", "isDeviceRelated", "id"]) {
					if (!(field in item)) fail(`results[${index}] has field ${field}`, "present", "missing");
				}
				if (!SOURCE_DOMAINS[item.source]?.test(String(item.url || ""))) fail(`results[${index}].url matches source domain`, String(SOURCE_DOMAINS[item.source]), item.url);
				if (!String(item.title || "").trim()) fail(`results[${index}].title is non-empty`, "non-empty", item.title);
				if (String(item.feedExcerpt || "").length > 500) fail(`results[${index}].feedExcerpt is short`, "<= 500 chars", String(item.feedExcerpt || "").length);
				if (item.isDeviceRelated !== true) fail(`results[${index}] is diabetes-device related`, true, item.isDeviceRelated);
				const key = item.id || item.url;
				if (seen.has(key)) fail(`results[${index}] id/url is unique`, "unique", key);
				seen.add(key);
				const ms = parseTime(item.publishedAt, `results[${index}].publishedAt`);
				if (Number.isFinite(ms) && Number.isFinite(startMs) && Number.isFinite(endMs) && (ms < startMs || ms >= endMs)) fail(`results[${index}].publishedAt is within [startIso,endIso)`, { startIso: input.startIso, endIso: input.endIso }, item.publishedAt);
				if (ms > lastTime) fail("results are newest first", "descending publishedAt", item.publishedAt);
				lastTime = ms;
			}
			if (isObject(data.summary) && Number(data.summary.totalMatches) !== data.results.length) {
				fail("summary.totalMatches matches results length", data.results.length, data.summary.totalMatches);
			}
		}
	}
}

if (failures.length) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
