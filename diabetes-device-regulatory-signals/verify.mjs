import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const JSON_NAME = "diabetes_device_regulatory_signals.json";
const FORBIDDEN_ARTIFACTS = ["diabetes_device_regulatory_signals.md", "diabetes_device_regulatory_signals.html"];
const SOURCE_DOMAINS = {
	"openFDA Device 510(k)": /^https:\/\/(api\.fda\.gov|www\.accessdata\.fda\.gov)\//,
	"openFDA Device Recall": /^https:\/\/(api\.fda\.gov|www\.accessdata\.fda\.gov)\//,
	"openFDA Device Enforcement": /^https:\/\/api\.fda\.gov\/device\/enforcement\.json\?/,
	"ClinicalTrials.gov": /^https:\/\/clinicaltrials\.gov\/study\/NCT\d+/,
	"FDA CDRH News and Updates": /^https:\/\/www\.fda\.gov\//,
	"FDA Medical Device Safety": /^https:\/\/www\.fda\.gov\//,
	"ADA Scientific Sessions": /^https:\/\/(professional\.diabetes\.org|diabetes\.org)\//,
	"ATTD Global": /^https:\/\/(attd\.kenes\.com|attd2027\.kenes\.com|attdasia\.kenes\.com|attd-hub\.kenes\.com)\//,
	"EASD Annual Meeting": /^https:\/\/www\.easd\.org\//,
};
const SIGNAL_TYPES = new Set(["510k", "recall", "enforcement", "trial", "fda-cdrh", "safety", "conference"]);
const SOURCE_FILTERS = new Set(["all", "openfda-510k", "openfda-recall", "openfda-enforcement", "clinicaltrials", "fda-cdrh", "fda-device-safety", "ada", "attd", "easd"]);
const PHASE25_SOURCE_FILTERS = new Set(["fda-cdrh", "fda-device-safety", "ada", "attd", "easd"]);
const TRIAL_DEVICE_EVIDENCE = /cgm|continuous glucose|glucose monitor|glucose monitoring|glucometer|sensor|insulin pump|bionic pancreas|artificial pancreas|closed[- ]loop|automated insulin|control-iq|omnipod|dexcom|freestyle libre|\blibre\b|eversense|minimed|tandem|ilet/i;
const OFFICIAL_DEVICE_EVIDENCE = /diabetes|diabetic|blood glucose|glucose meter|glucose monitor|glucose monitoring|continuous glucose|cgm|insulin pump|insulin infusion|automated insulin|artificial pancreas|closed[- ]loop|hybrid closed[- ]loop|dexcom|freestyle libre|\blibre\b|omnipod|insulet|eversense|minimed|medtronic diabetes|tandem diabetes|control-iq|mobi|ilet|beta bionics|true metrix|twiist/i;

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

function normalizeSourceFilter(value) {
	const raw = String(value || "").trim().toLowerCase();
	if (!raw || raw === "all" || raw === "全部") return "all";
	return raw;
}

function parseTime(value, label) {
	const ms = Date.parse(String(value || ""));
	if (!Number.isFinite(ms)) fail(`${label} is parseable datetime`, "valid datetime", value);
	return ms;
}

function parseDateOnly(value, label) {
	const raw = String(value || "").trim();
	const normalized = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
	const ms = Date.parse(`${normalized.slice(0, 10)}T00:00:00Z`);
	if (!Number.isFinite(ms)) fail(`${label} is parseable date`, "yyyy-mm-dd or yyyymmdd", value);
	return { ms, date: Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : raw };
}

function dateOnly(value) {
	const ms = Date.parse(String(value || ""));
	return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : String(value || "").slice(0, 10);
}

const outDir = process.env.TASK_OUTPUT_DIR || ".";
const input = parseJson(process.env.TASK_INPUT || "{}", "TASK_INPUT") || {};
const jsonPath = join(outDir, JSON_NAME);
const sourceFilter = normalizeSourceFilter(input.sourceFilter);

if (!existsSync(jsonPath)) fail("JSON artifact exists", JSON_NAME, "missing");
for (const name of FORBIDDEN_ARTIFACTS) {
	if (existsSync(join(outDir, name))) fail("collector emits JSON only", `no ${name}`, "present");
}

const startMs = parseTime(input.startIso, "TASK_INPUT.startIso");
const endMs = parseTime(input.endIso, "TASK_INPUT.endIso");
const startDay = dateOnly(input.startIso);
const endDay = dateOnly(input.endIso);
const startDayMs = Date.parse(`${startDay}T00:00:00Z`);
const endDayMs = Date.parse(`${endDay}T00:00:00Z`);

if (!SOURCE_FILTERS.has(sourceFilter)) fail("TASK_INPUT.sourceFilter is accepted", [...SOURCE_FILTERS], sourceFilter);
if (Number.isFinite(startMs) && Number.isFinite(endMs) && !(startMs < endMs)) fail("TASK_INPUT.startIso is before endIso", "start < end", { startIso: input.startIso, endIso: input.endIso });

if (existsSync(jsonPath)) {
	const data = parseJson(readFileSync(jsonPath, "utf8"), JSON_NAME);
	if (data) {
		for (const field of ["task", "retrievedAt", "timeWindow", "sources", "sourceStatus", "summary", "results"]) {
			if (!(field in data)) fail(`output has field ${field}`, "present", "missing");
		}
		if ("outputLanguage" in data) fail("collector output is language-neutral", "no outputLanguage field", data.outputLanguage);
		if (data.task !== "diabetes-device-regulatory-signals") fail("task name is correct", "diabetes-device-regulatory-signals", data.task);
		parseTime(data.retrievedAt, "retrievedAt");

		if (!isObject(data.timeWindow)) {
			fail("timeWindow is object", "object", data.timeWindow);
		} else {
			if (String(data.timeWindow.raw || "") !== String(input.timePhrase || "")) fail("timeWindow.raw matches input", input.timePhrase, data.timeWindow.raw);
			if (Number(data.timeWindow.days) !== Number(input.days)) fail("timeWindow.days matches input", input.days, data.timeWindow.days);
			if (String(data.timeWindow.startIso) !== new Date(startMs).toISOString()) fail("timeWindow.startIso matches input", input.startIso, data.timeWindow.startIso);
			if (String(data.timeWindow.endIso) !== new Date(endMs).toISOString()) fail("timeWindow.endIso matches input", input.endIso, data.timeWindow.endIso);
		}

		if (!Array.isArray(data.sources) || data.sources.length === 0) {
			fail("sources lists selected official systems", "non-empty array", data.sources);
		} else if (sourceFilter !== "all" && data.sources.some((item) => item?.filter !== sourceFilter)) {
			fail("sources respect sourceFilter", sourceFilter, data.sources.map((item) => item?.filter));
		} else if (sourceFilter === "all") {
			const filters = new Set(data.sources.map((item) => item?.filter));
			for (const filter of PHASE25_SOURCE_FILTERS) {
				if (!filters.has(filter)) fail("all sourceFilter includes phase 2.5 source", filter, [...filters]);
			}
		}

		if (!Array.isArray(data.sourceStatus) || data.sourceStatus.length !== data.sources?.length) {
			fail("sourceStatus has one row per selected source", data.sources?.length, data.sourceStatus?.length);
		} else if (data.sourceStatus.filter((item) => item?.ok === true).length === 0) {
			fail("at least one official source was reachable", ">= 1 ok source", 0);
		}

		if (!Array.isArray(data.results)) {
			fail("results is array", "Array", typeof data.results);
		} else {
			const seen = new Set();
			let lastDate = "9999-99-99";
			for (const [index, item] of data.results.entries()) {
				if (!isObject(item)) {
					fail(`results[${index}] is object`, "object", item);
					continue;
				}
				for (const field of ["source", "signalType", "title", "date", "url", "company", "deviceOrProduct", "context", "isDiabetesDeviceRelated", "id"]) {
					if (!(field in item)) fail(`results[${index}] has field ${field}`, "present", "missing");
				}
				if (!SOURCE_DOMAINS[item.source]?.test(String(item.url || ""))) fail(`results[${index}].url matches source domain`, String(SOURCE_DOMAINS[item.source]), item.url);
				if (!SIGNAL_TYPES.has(item.signalType)) fail(`results[${index}].signalType is accepted`, [...SIGNAL_TYPES], item.signalType);
				if (!String(item.title || "").trim()) fail(`results[${index}].title is non-empty`, "non-empty title", item.title);
				if (typeof item.isDiabetesDeviceRelated !== "boolean") fail(`results[${index}].isDiabetesDeviceRelated is boolean`, "boolean", item.isDiabetesDeviceRelated);
				if (item.isDiabetesDeviceRelated !== true) fail(`results[${index}] is diabetes-device related`, true, item.isDiabetesDeviceRelated);
				if (String(item.context || "").length > 500) fail(`results[${index}].context is short`, "<= 500 chars", String(item.context || "").length);
				const key = `${item.source}:${item.id}`;
				if (seen.has(key)) fail(`results[${index}] source/id is unique`, "unique source:id", key);
				seen.add(key);
				const date = parseDateOnly(item.date, `results[${index}].date`);
				if (Number.isFinite(date.ms) && Number.isFinite(startDayMs) && Number.isFinite(endDayMs) && (date.ms < startDayMs || date.ms > endDayMs)) {
					fail(`results[${index}].date is within requested day window`, { startDay, endDay }, item.date);
				}
				if (date.date > lastDate) fail("results are newest first", "descending date", { previous: lastDate, current: date.date });
				lastDate = date.date;
				if (item.signalType === "510k" && !/^K\d+/.test(String(item.id))) fail(`results[${index}] 510k id looks valid`, "K-number", item.id);
				if (item.signalType === "trial" && !/^NCT\d+/.test(String(item.id))) fail(`results[${index}] trial id looks valid`, "NCT number", item.id);
				if (item.signalType === "trial" && !TRIAL_DEVICE_EVIDENCE.test(String(item.deviceOrProduct || ""))) {
					fail(`results[${index}] trial device/product names device evidence`, "CGM/pump/AID/glucose-monitor term", { title: item.title, deviceOrProduct: item.deviceOrProduct });
				}
				if (["fda-cdrh", "safety", "conference"].includes(item.signalType) && !OFFICIAL_DEVICE_EVIDENCE.test(`${item.title}\n${item.deviceOrProduct}\n${item.context}`)) {
					fail(`results[${index}] official web signal has diabetes-device evidence`, "diabetes-device product or technology term", { title: item.title, deviceOrProduct: item.deviceOrProduct, context: item.context });
				}
			}
			if (isObject(data.summary) && Number(data.summary.totalSignals) !== data.results.length) {
				fail("summary.totalSignals matches results length", data.results.length, data.summary.totalSignals);
			}
		}
	}
}

if (failures.length) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
