import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const JSON_NAME = "diabetes_device_regulatory_signals.json";

const DEVICE_NAME_QUERY = '(device_name:"blood glucose" OR device_name:"continuous glucose" OR device_name:CGM OR device_name:"insulin pump" OR device_name:"insulin infusion" OR device_name:"diabetes management" OR device_name:"artificial pancreas" OR device_name:diabetes)';
const PRODUCT_QUERY = '(product_description:"blood glucose" OR product_description:"continuous glucose" OR product_description:CGM OR product_description:"insulin pump" OR product_description:"insulin infusion" OR product_description:"diabetes management" OR product_description:"artificial pancreas" OR product_description:diabetes)';

const SOURCES = [
	{ filter: "openfda-510k", source: "openFDA Device 510(k)", signalType: "510k" },
	{ filter: "openfda-recall", source: "openFDA Device Recall", signalType: "recall" },
	{ filter: "openfda-enforcement", source: "openFDA Device Enforcement", signalType: "enforcement" },
	{ filter: "clinicaltrials", source: "ClinicalTrials.gov", signalType: "trial" },
	{ filter: "fda-cdrh", source: "FDA CDRH News and Updates", signalType: "fda-cdrh" },
	{ filter: "fda-device-safety", source: "FDA Medical Device Safety", signalType: "safety" },
	{ filter: "ada", source: "ADA Scientific Sessions", signalType: "conference" },
	{ filter: "attd", source: "ATTD Global", signalType: "conference" },
	{ filter: "easd", source: "EASD Annual Meeting", signalType: "conference" },
];
const TRIAL_DEVICE_EVIDENCE = /cgm|continuous glucose|glucose monitor|glucose monitoring|glucometer|sensor|insulin pump|bionic pancreas|artificial pancreas|closed[- ]loop|automated insulin|control-iq|omnipod|dexcom|freestyle libre|\blibre\b|eversense|minimed|tandem|ilet/i;
const OFFICIAL_DEVICE_EVIDENCE = /diabetes|diabetic|blood glucose|glucose meter|glucose monitor|glucose monitoring|continuous glucose|cgm|insulin pump|insulin infusion|automated insulin|artificial pancreas|closed[- ]loop|hybrid closed[- ]loop|dexcom|freestyle libre|\blibre\b|omnipod|insulet|eversense|minimed|medtronic diabetes|tandem diabetes|control-iq|mobi|ilet|beta bionics|true metrix|twiist/i;
const TRIAL_DEVICE_LABELS = [
	["CGM", /\bCGM\b|continuous glucose/i],
	["glucose monitor", /glucose monitor|glucose monitoring|glucometer|blood glucose/i],
	["sensor", /\bsensors?\b/i],
	["insulin pump", /insulin pump/i],
	["automated insulin delivery", /automated insulin/i],
	["closed-loop", /closed[- ]loop/i],
	["artificial pancreas", /artificial pancreas/i],
	["bionic pancreas", /bionic pancreas/i],
	["Control-IQ", /control-iq/i],
	["Omnipod", /omnipod/i],
	["Dexcom", /dexcom/i],
	["FreeStyle Libre", /freestyle libre|\blibre\b/i],
	["Eversense", /eversense/i],
	["MiniMed", /minimed/i],
	["Tandem", /tandem/i],
	["iLet", /\bilet\b/i],
];

function die(message) {
	console.error(message);
	process.exit(1);
}

function normalizeSourceFilter(value) {
	const raw = String(value || "").trim().toLowerCase();
	if (!raw || raw === "all" || raw === "全部") return "all";
	if (/510|clearance|k号|批准|获批/.test(raw)) return "openfda-510k";
	if (/recall|correction|召回|纠正/.test(raw)) return "openfda-recall";
	if (/enforcement|执法/.test(raw)) return "openfda-enforcement";
	if (/clinical|trial|试验|临床/.test(raw)) return "clinicaltrials";
	if (/safety|early alert|alert|安全|警示/.test(raw)) return "fda-device-safety";
	if (/cdrh|fda/.test(raw)) return "fda-cdrh";
	if (/ada|scientific sessions|美国糖尿病协会/.test(raw)) return "ada";
	if (/attd/.test(raw)) return "attd";
	if (/easd|欧洲糖尿病/.test(raw)) return "easd";
	return raw;
}

function readInput() {
	let input;
	try {
		input = JSON.parse(process.env.TASK_INPUT || "{}");
	} catch (error) {
		die(`TASK_INPUT is not valid JSON: ${error.message}`);
	}
	const days = Number(input.days);
	const startMs = Date.parse(String(input.startIso || ""));
	const endMs = Date.parse(String(input.endIso || ""));
	const maxItems = Math.min(300, Math.max(1, Number(input.maxItems || 100)));
	const sourceFilter = normalizeSourceFilter(input.sourceFilter);
	if (!String(input.timePhrase || "").trim()) die("TASK_INPUT.timePhrase is required");
	if (!Number.isInteger(days) || days < 1 || days > 30) die("TASK_INPUT.days must be an integer in 1..30");
	if (!Number.isFinite(startMs)) die("TASK_INPUT.startIso must be a valid ISO datetime");
	if (!Number.isFinite(endMs)) die("TASK_INPUT.endIso must be a valid ISO datetime");
	if (!(startMs < endMs)) die("TASK_INPUT.startIso must be before endIso");
	if (!["all", ...SOURCES.map((source) => source.filter)].includes(sourceFilter)) die(`TASK_INPUT.sourceFilter is invalid: ${sourceFilter}`);
	const startDate = new Date(startMs).toISOString().slice(0, 10);
	const endDate = new Date(endMs).toISOString().slice(0, 10);
	return {
		timePhrase: String(input.timePhrase),
		days,
		startIso: new Date(startMs).toISOString(),
		endIso: new Date(endMs).toISOString(),
		startDate,
		endDate,
		startCompact: startDate.replaceAll("-", ""),
		endCompact: endDate.replaceAll("-", ""),
		maxItems,
		sourceFilter,
	};
}

function selectedSources(sourceFilter) {
	return sourceFilter === "all" ? SOURCES : SOURCES.filter((source) => source.filter === sourceFilter);
}

function buildUrl(base, params) {
	const url = new URL(base);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return url;
}

async function fetchJson(url) {
	const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "ugk-diabetes-device-regulatory-signals/1.0" } });
	const text = await response.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
	}
	if (response.status === 404 && data?.error?.code === "NOT_FOUND") return { data: { results: [], studies: [] }, empty: true };
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${data?.error?.message || text.slice(0, 160)}`);
	return { data, empty: false };
}

async function fetchText(url) {
	const response = await fetch(url, { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.5", "user-agent": "ugk-diabetes-device-regulatory-signals/1.0" } });
	const text = await response.text();
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
	return text;
}

function htmlDecode(value) {
	return String(value || "")
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function stripHtml(value) {
	return htmlDecode(value)
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeDate(value) {
	const raw = String(value || "").trim();
	if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
	return raw.slice(0, 10);
}

function normalizeOfficialDate(value) {
	const raw = stripHtml(value);
	const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
	const ms = Date.parse(raw);
	return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : normalizeDate(raw);
}

function dateInWindow(date, input) {
	const day = normalizeOfficialDate(date);
	return day >= input.startDate && day <= input.endDate;
}

function shortText(value, max = 420) {
	const text = String(value || "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (text.length <= max) return text;
	const head = text.slice(0, max);
	const cut = Math.max(head.lastIndexOf("."), head.lastIndexOf(";"), head.lastIndexOf("。"));
	return cut > 180 ? head.slice(0, cut + 1) : `${head.slice(0, max - 3).trimEnd()}...`;
}

function deviceEvidenceText(values) {
	const text = values.filter(Boolean).join("\n");
	return TRIAL_DEVICE_LABELS
		.filter(([, pattern]) => pattern.test(text))
		.map(([label]) => label)
		.join("; ");
}

function normalizeUrl(value) {
	try {
		const url = new URL(value);
		url.hash = "";
		return url.href.replace(/\/$/, "");
	} catch {
		return String(value || "").trim();
	}
}

function isDiabetesDeviceOfficialText(value) {
	return OFFICIAL_DEVICE_EVIDENCE.test(stripHtml(value));
}

function linkItems(block, baseUrl) {
	const items = [];
	for (const match of String(block || "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
		const href = htmlDecode(match[1]).trim();
		if (!href || /^(#|mailto:|javascript:)/i.test(href)) continue;
		let url;
		try {
			url = new URL(href, baseUrl).href;
		} catch {
			continue;
		}
		const title = shortText(stripHtml(match[2]), 220);
		if (title) items.push({ title, url });
	}
	return items;
}

function officialResult(source, link, date, deviceOrProduct, context) {
	return {
		source: source.source,
		signalType: source.signalType,
		title: link.title,
		date: normalizeOfficialDate(date),
		url: link.url,
		company: "",
		deviceOrProduct: shortText(deviceOrProduct || link.title, 220),
		context: shortText(context || source.source),
		isDiabetesDeviceRelated: true,
		id: normalizeUrl(link.url).replace(/^https?:\/\//, ""),
	};
}

function openFdaRecordUrl(endpoint, field, value) {
	const url = buildUrl(`https://api.fda.gov/device/${endpoint}.json`, { search: `${field}:"${value}"`, limit: "1" });
	return String(url);
}

async function collect510k(input) {
	const queryUrl = buildUrl("https://api.fda.gov/device/510k.json", {
		search: `decision_date:[${input.startCompact} TO ${input.endCompact}] AND ${DEVICE_NAME_QUERY}`,
		limit: String(Math.min(1000, Math.max(25, input.maxItems * 3))),
		sort: "decision_date:desc",
	});
	const { data, empty } = await fetchJson(queryUrl);
	const records = data.results || [];
	return {
		status: { source: "openFDA Device 510(k)", signalType: "510k", filter: "openfda-510k", ok: true, queryUrl: String(queryUrl), total: data?.meta?.results?.total || 0, itemCount: records.length, matchedCount: records.length, empty },
		results: records.map((item) => ({
			source: "openFDA Device 510(k)",
			signalType: "510k",
			title: item.device_name || item.k_number,
			date: normalizeDate(item.decision_date),
			url: `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID=${encodeURIComponent(item.k_number || "")}`,
			company: item.applicant || "",
			deviceOrProduct: item.device_name || "",
			context: shortText([item.decision_description && `Decision: ${item.decision_description}`, item.date_received && `Received: ${normalizeDate(item.date_received)}`, item.medical_specialty_description].filter(Boolean).join("; ")),
			isDiabetesDeviceRelated: true,
			id: item.k_number || "",
		})),
	};
}

async function collectRecall(input) {
	const queryUrl = buildUrl("https://api.fda.gov/device/recall.json", {
		search: `event_date_initiated:[${input.startCompact} TO ${input.endCompact}] AND ${PRODUCT_QUERY}`,
		limit: String(Math.min(1000, Math.max(25, input.maxItems * 3))),
	});
	const { data, empty } = await fetchJson(queryUrl);
	const records = data.results || [];
	return {
		status: { source: "openFDA Device Recall", signalType: "recall", filter: "openfda-recall", ok: true, queryUrl: String(queryUrl), total: data?.meta?.results?.total || 0, itemCount: records.length, matchedCount: records.length, empty },
		results: records.map((item) => ({
			source: "openFDA Device Recall",
			signalType: "recall",
			title: shortText(item.product_description, 180),
			date: normalizeDate(item.event_date_initiated || item.event_date_posted),
			url: item.res_event_number ? `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfRes/res.cfm?id=${encodeURIComponent(item.res_event_number)}` : openFdaRecordUrl("recall", "cfres_id", item.cfres_id || item.product_res_number || ""),
			company: item.recalling_firm || "",
			deviceOrProduct: shortText(item.openfda?.device_name || item.product_description, 220),
			context: shortText(item.reason_for_recall || item.root_cause_description || item.action),
			isDiabetesDeviceRelated: true,
			id: item.product_res_number || item.cfres_id || item.res_event_number || "",
		})),
	};
}

async function collectEnforcement(input) {
	const queryUrl = buildUrl("https://api.fda.gov/device/enforcement.json", {
		search: `report_date:[${input.startCompact} TO ${input.endCompact}] AND ${PRODUCT_QUERY}`,
		limit: String(Math.min(1000, Math.max(25, input.maxItems * 3))),
	});
	const { data, empty } = await fetchJson(queryUrl);
	const records = data.results || [];
	return {
		status: { source: "openFDA Device Enforcement", signalType: "enforcement", filter: "openfda-enforcement", ok: true, queryUrl: String(queryUrl), total: data?.meta?.results?.total || 0, itemCount: records.length, matchedCount: records.length, empty },
		results: records.map((item) => ({
			source: "openFDA Device Enforcement",
			signalType: "enforcement",
			title: shortText(item.product_description, 180),
			date: normalizeDate(item.report_date || item.recall_initiation_date),
			url: openFdaRecordUrl("enforcement", "recall_number", item.recall_number || item.event_id || ""),
			company: item.recalling_firm || "",
			deviceOrProduct: shortText(item.product_description, 220),
			context: shortText([item.classification, item.status, item.reason_for_recall].filter(Boolean).join("; ")),
			isDiabetesDeviceRelated: true,
			id: item.recall_number || item.event_id || "",
		})),
	};
}

function clinicalDiabetesText(study) {
	const protocol = study.protocolSection || {};
	return [
		protocol.identificationModule?.briefTitle,
		protocol.descriptionModule?.briefSummary,
		...(protocol.conditionsModule?.conditions || []),
	].filter(Boolean).join("\n");
}

function clinicalDeviceText(study) {
	const protocol = study.protocolSection || {};
	return [
		protocol.identificationModule?.briefTitle,
		...(protocol.armsInterventionsModule?.interventions || []).map((item) => item.name),
	].filter(Boolean).join("\n");
}

function isDiabetesDeviceTrial(study) {
	const text = clinicalDiabetesText(study).toLowerCase();
	const hasDiabetes = /diabetes|diabetic|type 1|type 2|t1d|t2d|glycemic/.test(text);
	const hasDevice = TRIAL_DEVICE_EVIDENCE.test(clinicalDeviceText(study));
	return hasDiabetes && hasDevice;
}

async function collectClinicalTrials(input) {
	const queryUrl = buildUrl("https://clinicaltrials.gov/api/v2/studies", {
		format: "json",
		pageSize: String(Math.min(100, Math.max(10, input.maxItems * 3))),
		"query.term": 'diabetes (CGM OR "continuous glucose" OR "blood glucose" OR "insulin pump" OR "automated insulin" OR "artificial pancreas" OR "bionic pancreas" OR "closed loop")',
		"filter.advanced": `AREA[LastUpdatePostDate]RANGE[${input.startDate},${input.endDate}]`,
	});
	const { data, empty } = await fetchJson(queryUrl);
	const studies = data.studies || [];
	const results = studies.filter(isDiabetesDeviceTrial).map((study) => {
		const protocol = study.protocolSection || {};
		const id = protocol.identificationModule?.nctId || "";
		const title = protocol.identificationModule?.briefTitle || id;
		const summary = protocol.descriptionModule?.briefSummary || "";
		const interventions = protocol.armsInterventionsModule?.interventions?.map((item) => item.name).filter(Boolean) || [];
		const deviceInterventions = interventions.filter((item) => TRIAL_DEVICE_EVIDENCE.test(item));
		const deviceOrProduct = deviceInterventions.length
			? deviceInterventions.join("; ")
			: deviceEvidenceText([title, summary]);
		const sponsor = protocol.sponsorCollaboratorsModule?.leadSponsor?.name || "";
		return {
			source: "ClinicalTrials.gov",
			signalType: "trial",
			title,
			date: normalizeDate(protocol.statusModule?.lastUpdatePostDateStruct?.date || protocol.statusModule?.studyFirstPostDateStruct?.date),
			url: `https://clinicaltrials.gov/study/${id}`,
			company: sponsor,
			deviceOrProduct: shortText(deviceOrProduct || interventions.join("; "), 220),
			context: shortText([
				protocol.statusModule?.overallStatus && `Status: ${protocol.statusModule.overallStatus}`,
				(protocol.conditionsModule?.conditions || []).join("; "),
			].filter(Boolean).join("; ")),
			isDiabetesDeviceRelated: true,
			id,
		};
	});
	return {
		status: { source: "ClinicalTrials.gov", signalType: "trial", filter: "clinicaltrials", ok: true, queryUrl: String(queryUrl), total: data.totalCount || studies.length, itemCount: studies.length, matchedCount: results.length, empty },
		results,
	};
}

function parseDatedOfficialLinks(html, url, source, input) {
	const results = [];
	let itemCount = 0;
	for (const match of html.matchAll(/<h[2-4]\b[^>]*>\s*([A-Z][a-z]+ \d{1,2}, \d{4})\s*<\/h[2-4]>([\s\S]*?)(?=<h[2-4]\b|<\/main>|$)/g)) {
		const date = normalizeOfficialDate(match[1]);
		for (const link of linkItems(match[2], url)) {
			itemCount += 1;
			const text = `${link.title}\n${link.url}`;
			if (dateInWindow(date, input) && isDiabetesDeviceOfficialText(text)) {
				results.push(officialResult(source, link, date, link.title, source.source));
			}
		}
	}
	return { itemCount, results };
}

async function collectFdaCdrh(input, source) {
	const queryUrl = "https://www.fda.gov/medical-devices/medical-devices-news-and-events/cdrh-new-news-and-updates";
	const html = await fetchText(queryUrl);
	const parsed = parseDatedOfficialLinks(html, queryUrl, source, input);
	return {
		status: { source: source.source, signalType: source.signalType, filter: source.filter, ok: true, queryUrl, total: parsed.itemCount, itemCount: parsed.itemCount, matchedCount: parsed.results.length, empty: parsed.results.length === 0 },
		results: parsed.results,
	};
}

function parseTableCells(row) {
	return [...String(row || "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
}

async function collectFdaDeviceSafety(input, source) {
	const queryUrl = "https://www.fda.gov/medical-devices/medical-device-safety/medical-device-recalls-and-early-alerts";
	const html = await fetchText(queryUrl);
	const results = [];
	let itemCount = 0;
	for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
		const cells = parseTableCells(row[1]);
		if (cells.length < 4) continue;
		const date = normalizeOfficialDate(cells[0]);
		const link = linkItems(cells[1], queryUrl)[0];
		if (!link) continue;
		itemCount += 1;
		const productArea = stripHtml(cells[2]);
		const status = stripHtml(cells[3]);
		const text = `${link.title}\n${productArea}\n${status}\n${link.url}`;
		if (dateInWindow(date, input) && isDiabetesDeviceOfficialText(text)) {
			results.push(officialResult(source, link, date, productArea || link.title, status));
		}
	}
	return {
		status: { source: source.source, signalType: source.signalType, filter: source.filter, ok: true, queryUrl, total: itemCount, itemCount, matchedCount: results.length, empty: results.length === 0 },
		results,
	};
}

function datedConferenceLinks(html, url, source, input) {
	const results = [];
	const links = linkItems(html, url);
	const seen = new Set();
	for (const link of links) {
		const key = normalizeUrl(link.url);
		if (seen.has(key)) continue;
		seen.add(key);
		const dateMatch = `${link.title}\n${link.url}`.match(/\b(?:20\d{2}-\d{2}-\d{2}|[A-Z][a-z]+ \d{1,2}, 20\d{2})\b/);
		if (!dateMatch) continue;
		const date = normalizeOfficialDate(dateMatch[0]);
		if (dateInWindow(date, input) && isDiabetesDeviceOfficialText(`${link.title}\n${link.url}\n${source.source}`)) {
			results.push(officialResult(source, link, date, link.title, source.source));
		}
	}
	return { itemCount: links.length, results };
}

async function collectConferencePage(input, source) {
	const urls = {
		ada: "https://professional.diabetes.org/scientific-sessions",
		attd: "https://attd.kenes.com/",
		easd: "https://www.easd.org/annual-meeting.html",
	};
	const queryUrl = urls[source.filter];
	const html = await fetchText(queryUrl);
	const parsed = datedConferenceLinks(html, queryUrl, source, input);
	return {
		status: { source: source.source, signalType: source.signalType, filter: source.filter, ok: true, queryUrl, total: parsed.itemCount, itemCount: parsed.itemCount, matchedCount: parsed.results.length, empty: parsed.results.length === 0 },
		results: parsed.results,
	};
}

async function collectSource(source, input) {
	try {
		if (source.filter === "openfda-510k") return await collect510k(input);
		if (source.filter === "openfda-recall") return await collectRecall(input);
		if (source.filter === "openfda-enforcement") return await collectEnforcement(input);
		if (source.filter === "clinicaltrials") return await collectClinicalTrials(input);
		if (source.filter === "fda-cdrh") return await collectFdaCdrh(input, source);
		if (source.filter === "fda-device-safety") return await collectFdaDeviceSafety(input, source);
		if (["ada", "attd", "easd"].includes(source.filter)) return await collectConferencePage(input, source);
		throw new Error(`Unsupported source: ${source.filter}`);
	} catch (error) {
		return {
			status: { source: source.source, signalType: source.signalType, filter: source.filter, ok: false, queryUrl: "", total: 0, itemCount: 0, matchedCount: 0, error: error.message || String(error) },
			results: [],
		};
	}
}

function dedupeAndSort(results, maxItems) {
	const seen = new Set();
	return results
		.filter((item) => {
			if (!item.id || !item.url || !item.date || !item.title) return false;
			const key = `${item.source}:${item.id}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => b.date.localeCompare(a.date) || a.source.localeCompare(b.source) || a.title.localeCompare(b.title))
		.slice(0, maxItems);
}

function countBy(items, field) {
	const counts = {};
	for (const item of items) counts[item[field]] = (counts[item[field]] || 0) + 1;
	return counts;
}

const input = readInput();
const outputDir = process.env.TASK_OUTPUT_DIR || die("TASK_OUTPUT_DIR is required");
const collected = await Promise.all(selectedSources(input.sourceFilter).map((source) => collectSource(source, input)));
const sourceStatus = collected.map((entry) => entry.status);
const results = dedupeAndSort(collected.flatMap((entry) => entry.results), input.maxItems);

const data = {
	task: "diabetes-device-regulatory-signals",
	retrievedAt: new Date().toISOString(),
	timeWindow: {
		raw: input.timePhrase,
		days: input.days,
		startIso: input.startIso,
		endIso: input.endIso,
	},
	sources: selectedSources(input.sourceFilter),
	sourceStatus,
	summary: {
		totalSources: sourceStatus.length,
		successfulSources: sourceStatus.filter((item) => item.ok).length,
		totalFetched: sourceStatus.reduce((sum, item) => sum + Number(item.itemCount || 0), 0),
		totalSignals: results.length,
		bySignalType: countBy(results, "signalType"),
		bySource: countBy(results, "source"),
	},
	results,
};

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, JSON_NAME), JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(`Wrote ${results.length} regulatory signals to ${outputDir}`);
