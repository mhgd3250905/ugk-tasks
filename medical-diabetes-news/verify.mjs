import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const JSON_NAME = "medical_diabetes_news.json";
const FORBIDDEN_ARTIFACTS = ["medical_diabetes_news.md", "medical_diabetes_news.html"];
const SOURCE_DOMAINS = {
	"Healio": /^https:\/\/www\.healio\.com\//,
	"BioSpace": /^https:\/\/www\.biospace\.com\//,
	"STAT News": /^https:\/\/www\.statnews\.com\//,
	"Reuters": /^https:\/\/www\.reuters\.com\//,
	"Fierce Biotech": /^https:\/\/www\.fiercebiotech\.com\//,
	"Fierce Pharma": /^https:\/\/www\.fiercepharma\.com\//,
	"MedTech Dive": /^https:\/\/www\.medtechdive\.com\//,
	"Eli Lilly IR": /^https:\/\/investor\.lilly\.com\//,
	"Drug Delivery Business News": /^https:\/\/www\.drugdeliverybusiness\.com\//,
	"Medical Device Network": /^https:\/\/www\.medicaldevice-network\.com\//,
	"Diabetotech": /^https:\/\/www\.diabetotech\.com\//,
	"Abbott Newsroom": /^https:\/\/abbott\.mediaroom\.com\//,
	"Sanofi US News": /^https:\/\/www\.news\.sanofi\.us\//,
	"MiniMed Newsroom": /^https:\/\/news\.minimed\.com\//,
	"Medtronic Diabetes": /^https:\/\/news\.medtronic\.com\//,
	"Tandem Diabetes Care IR": /^https:\/\/investor\.tandemdiabetes\.com\//,
	"Beta Bionics IR": /^https:\/\/investors\.betabionics\.com\//,
	"embecta IR": /^https:\/\/investors\.embecta\.com\//,
	"Medical Design & Outsourcing": /^https:\/\/www\.medicaldesignandoutsourcing\.com\//,
	"MedTech Intelligence": /^https:\/\/medtechintelligence\.com\//,
	"Tidepool Blog": /^https:\/\/www\.tidepool\.org\//,
	"Glooko": /^https:\/\/glooko\.com\//,
	"Diabeloop": /^https:\/\/www\.diabeloop\.com\//,
	"PR Newswire Health": /^https:\/\/www\.prnewswire\.com\//,
	"FDA CDRH New": /^https:\/\/www\.fda\.gov\//,
};
const REQUIRED_FEEDS = new Set([
	"https://www.drugdeliverybusiness.com/category/diabetes-etc/feed/",
	"https://www.drugdeliverybusiness.com/tag/dexcom/feed/",
	"https://www.drugdeliverybusiness.com/tag/insulet/feed/",
	"https://www.drugdeliverybusiness.com/tag/tandem-diabetes-care/feed/",
]);

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
		if (data.task !== "medical-diabetes-news") fail("task name is correct", "medical-diabetes-news", data.task);
		parseTime(data.retrievedAt, "retrievedAt");

		if (!isObject(data.timeWindow)) {
			fail("timeWindow is object", "object", data.timeWindow);
		} else {
			if (String(data.timeWindow.raw || "") !== String(input.timePhrase || "")) fail("timeWindow.raw matches input", input.timePhrase, data.timeWindow.raw);
			if (Number(data.timeWindow.days) !== Number(input.days)) fail("timeWindow.days matches input", input.days, data.timeWindow.days);
			if (String(data.timeWindow.startIso) !== new Date(startMs).toISOString()) fail("timeWindow.startIso matches input", input.startIso, data.timeWindow.startIso);
			if (String(data.timeWindow.endIso) !== new Date(endMs).toISOString()) fail("timeWindow.endIso matches input", input.endIso, data.timeWindow.endIso);
		}

		if (!Array.isArray(data.sources) || data.sources.length < 10) fail("sources lists first-stage platforms", ">= 10 sources", data.sources);
		if (!Array.isArray(data.sourceStatus) || data.sourceStatus.length < 10) {
			fail("sourceStatus lists feed results", ">= 10 feed status rows", data.sourceStatus);
		} else {
			const okCount = data.sourceStatus.filter((item) => item?.ok === true).length;
			if (okCount < 8) fail("enough feeds were reachable", ">= 8 successful feeds", okCount);
			const byFeed = new Map(data.sourceStatus.map((item) => [item?.feedUrl, item]));
			for (const feedUrl of REQUIRED_FEEDS) {
				const status = byFeed.get(feedUrl);
				if (!status) fail("required high-signal feed is configured", feedUrl, "missing");
				else if (status.ok !== true || Number(status.itemCount || 0) < 1) fail("required high-signal feed is reachable", `${feedUrl} ok with items`, status);
			}
		}

		if (!Array.isArray(data.results)) {
			fail("results is array", "Array", typeof data.results);
		} else {
			const seenUrls = new Set();
			let sawNonDevice = false;
			let lastDeviceTime = Infinity;
			let lastOtherTime = Infinity;
			for (const [index, item] of data.results.entries()) {
				if (!isObject(item)) {
					fail(`results[${index}] is object`, "object", item);
					continue;
				}
				for (const field of ["source", "title", "publishedAt", "url", "feedExcerpt", "isDeviceRelated"]) {
					if (!(field in item)) fail(`results[${index}] has field ${field}`, "present", "missing");
				}
				const domain = SOURCE_DOMAINS[item.source];
				if (!domain) fail(`results[${index}].source is accepted`, Object.keys(SOURCE_DOMAINS), item.source);
				else if (!domain.test(String(item.url || ""))) fail(`results[${index}].url matches source domain`, String(domain), item.url);
				if (seenUrls.has(item.url)) fail(`results[${index}].url is unique`, "unique URL", item.url);
				seenUrls.add(item.url);
				if (typeof item.feedExcerpt !== "string") fail(`results[${index}].feedExcerpt is string`, "string", item.feedExcerpt);
				if (String(item.feedExcerpt || "").length > 420) fail(`results[${index}].feedExcerpt is short`, "<= 420 chars", item.feedExcerpt.length);
				if (typeof item.isDeviceRelated !== "boolean") fail(`results[${index}].isDeviceRelated is boolean`, "boolean", item.isDeviceRelated);
				const publishedMs = parseTime(item.publishedAt, `results[${index}].publishedAt`);
				if (Number.isFinite(publishedMs) && Number.isFinite(startMs) && Number.isFinite(endMs) && (publishedMs < startMs || publishedMs >= endMs)) {
					fail(`results[${index}].publishedAt is within [startIso,endIso)`, { startIso: input.startIso, endIso: input.endIso }, item.publishedAt);
				}
				if (item.isDeviceRelated) {
					if (sawNonDevice) fail("device-related results are ranked before diabetes-only results", "all device results first", `device result at index ${index}`);
					if (publishedMs > lastDeviceTime) fail("device-related results are newest first", "descending publishedAt", item.publishedAt);
					lastDeviceTime = publishedMs;
				} else {
					sawNonDevice = true;
					if (publishedMs > lastOtherTime) fail("non-device results are newest first", "descending publishedAt", item.publishedAt);
					lastOtherTime = publishedMs;
				}
			}
			if (isObject(data.summary)) {
				if (Number(data.summary.totalMatches) !== data.results.length) fail("summary.totalMatches matches results length", data.results.length, data.summary.totalMatches);
				if (Number(data.summary.deviceRelated) !== data.results.filter((item) => item.isDeviceRelated).length) fail("summary.deviceRelated matches results", "device result count", data.summary.deviceRelated);
			}
		}
	}
}

if (failures.length) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
