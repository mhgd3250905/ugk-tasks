import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const JSON_NAME = "diabetes_device_custom_source_news.json";
const RUN_LOCK_DIR = join(tmpdir(), "ugk-diabetes-device-custom-source-news.lock");
const RUN_LOCK_STALE_MS = 30 * 60 * 1000;

const SOURCES = [
	{ filter: "sequel", source: "Sequel Med Tech", mode: "sequelHtml", url: "https://www.sequelmedtech.com/news" },
	{ filter: "senseonics", source: "Senseonics", mode: "rss", url: "https://www.senseonics.com/rss/news-releases.xml" },
	{ filter: "dexcom", source: "Dexcom IR", mode: "q4Cdp", url: "https://investors.dexcom.com/news/default.aspx" },
	{ filter: "insulet", source: "Insulet IR", mode: "q4Cdp", url: "https://investors.insulet.com/news/default.aspx" },
	{ filter: "massdevice", source: "MassDevice", mode: "massdeviceCdp", url: "https://www.massdevice.com/massdevice-article-archive/" },
	{ filter: "mobihealthnews", source: "MobiHealthNews", mode: "mobiCdp", url: "https://www.mobihealthnews.com/tag/dexcom" },
];

const DEVICE_TERMS = /diabetes|diabetic|t1d|t2d|glucose|glycemic|cgm|continuous glucose|insulin|automated insulin|aid system|closed[- ]loop|pump|twiist|eversense|dexcom|omnipod|insulet|senseonics|sequel|massdevice|mobihealthnews/i;
const STRONG_DEVICE_TERMS = /diabetes|diabetic|type 1|type 2|t1d|t2d|glucose|biosensing|glycemic|cgm|continuous glucose|insulin|automated insulin|aid system|closed[- ]loop|pump|omnipod|stelo|freestyle libre|\blibre\b|sensor/i;
const CDP_MODES = new Set(["q4Cdp", "massdeviceCdp", "mobiCdp"]);

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
	const days = Number(input.days);
	const startMs = Date.parse(String(input.startIso || ""));
	const endMs = Date.parse(String(input.endIso || ""));
	const maxItems = Math.min(300, Math.max(1, Number(input.maxItems || 100)));
	if (!String(input.timePhrase || "").trim()) die("TASK_INPUT.timePhrase is required");
	if (!Number.isInteger(days) || days < 1 || days > 30) die("TASK_INPUT.days must be an integer in 1..30");
	if (!Number.isFinite(startMs)) die("TASK_INPUT.startIso must be a valid ISO datetime");
	if (!Number.isFinite(endMs)) die("TASK_INPUT.endIso must be a valid ISO datetime");
	if (!(startMs < endMs)) die("TASK_INPUT.startIso must be before endIso");
	return {
		timePhrase: String(input.timePhrase),
		days,
		startIso: new Date(startMs).toISOString(),
		endIso: new Date(endMs).toISOString(),
		startMs,
		endMs,
		maxItems,
	};
}

function decode(value) {
	return String(value || "")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
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
	return decode(value)
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function shortText(value, max = 420) {
	const text = stripHtml(value);
	if (text.length <= max) return text;
	const head = text.slice(0, max);
	const cut = Math.max(head.lastIndexOf("."), head.lastIndexOf(";"), head.lastIndexOf("。"));
	return cut > 180 ? head.slice(0, cut + 1) : `${head.slice(0, max - 3).trimEnd()}...`;
}

function tagValue(block, tag) {
	const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = String(block || "").match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
	return match ? decode(match[1]).trim() : "";
}

function attrValue(block, attr) {
	const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = String(block || "").match(new RegExp(`\\s${escaped}=["']([^"']+)["']`, "i"));
	return match ? decode(match[1]).trim() : "";
}

function toIso(value) {
	const raw = String(value || "").trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
	if (/^[A-Za-z]+ \d{1,2}, \d{4}$/.test(raw)) {
		const ms = Date.parse(`${raw} 00:00:00 UTC`);
		return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
	}
	const ms = Date.parse(raw);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function normalizeUrl(value, base) {
	try {
		const url = new URL(decode(value).trim(), base);
		url.hash = "";
		return url.href.replace(/\/$/, "");
	} catch {
		return String(value || "").trim();
	}
}

async function fetchText(url) {
	const response = await fetch(url, {
		headers: {
			accept: "text/html,application/rss+xml,application/xml,*/*;q=0.5",
			"user-agent": "Mozilla/5.0 ugk-diabetes-device-custom-source-news/1.0",
		},
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
	return text;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

function chromeExecutable() {
	const candidates = [
		process.env.CHROME_PATH,
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	].filter(Boolean);
	const found = candidates.find((path) => existsSync(path));
	if (!found) throw new Error("Chrome/Edge executable not found");
	return found;
}

async function jsonWithRetry(url, attempts = 40) {
	for (let i = 0; i < attempts; i += 1) {
		try {
			const response = await fetch(url);
			if (response.ok) return response.json();
		} catch {
			// retry
		}
		await sleep(250);
	}
	throw new Error(`DevTools endpoint not ready: ${url}`);
}

function cdpClient(wsUrl) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		let id = 0;
		const pending = new Map();
		ws.onopen = () => {
			ws.onmessage = (event) => {
				const message = JSON.parse(event.data);
				if (message.id && pending.has(message.id)) {
					pending.get(message.id)(message);
					pending.delete(message.id);
				}
			};
			resolve({
				send(method, params = {}, sessionId = undefined) {
					const message = { id: ++id, method, params };
					if (sessionId) message.sessionId = sessionId;
					ws.send(JSON.stringify(message));
					return new Promise((done) => pending.set(message.id, done));
				},
				close() {
					ws.close();
				},
			});
		};
		ws.onerror = reject;
	});
}

function timeout(promise, ms) {
	return Promise.race([promise, sleep(ms).then(() => undefined)]);
}

async function acquireRunLock() {
	try {
		await mkdir(RUN_LOCK_DIR);
		await writeFile(join(RUN_LOCK_DIR, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n", "utf8");
		return;
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		let stale = false;
		try {
			const info = await stat(RUN_LOCK_DIR);
			stale = Date.now() - info.mtimeMs > RUN_LOCK_STALE_MS;
		} catch {
			stale = true;
		}
		if (stale) {
			await rm(RUN_LOCK_DIR, { recursive: true, force: true });
			return acquireRunLock();
		}
		throw new Error("Another diabetes-device-custom-source-news run is already active; wait for it to finish before starting another.");
	}
}

async function releaseRunLock() {
	await rm(RUN_LOCK_DIR, { recursive: true, force: true });
}

function killProcessTree(child) {
	if (!child?.pid) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		return;
	}
	child.kill("SIGKILL");
}

let cdpBrowser;

async function getCdpBrowser() {
	if (cdpBrowser) return cdpBrowser;
	const port = await freePort();
	const profile = await mkdtemp(join(tmpdir(), "ugk-cdp-phase4-"));
	const child = spawn(chromeExecutable(), [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-gpu",
		"--window-size=1200,900",
		"about:blank",
	], { stdio: "ignore", windowsHide: true });
	const version = await jsonWithRetry(`http://127.0.0.1:${port}/json/version`);
	const client = await cdpClient(version.webSocketDebuggerUrl);
	await client.send("Target.setDiscoverTargets", { discover: true });
	cdpBrowser = { client, child, profile };
	return cdpBrowser;
}

async function closeCdpBrowser() {
	if (!cdpBrowser) return;
	const { client, child, profile } = cdpBrowser;
	cdpBrowser = undefined;
	try {
		await timeout(client.send("Browser.close"), 2000);
	} catch {
		// ignore
	}
	try {
		client.close();
	} catch {
		// ignore
	}
	await sleep(1200);
	killProcessTree(child);
	await rm(profile, { recursive: true, force: true }).catch(() => {});
}

async function withCdpPage(url, evaluateExpression, waitExpression = "document.body && document.body.innerText.length > 500", options = {}) {
	const { diagnostic = false, minWaitMs = 8000, maxWaitMs = 120000 } = options;
	const { client } = await getCdpBrowser();
	let targetId;
	try {
		const target = await client.send("Target.createTarget", { url: "about:blank" });
		targetId = target.result.targetId;
		const attached = await client.send("Target.attachToTarget", { targetId, flatten: true });
		const sessionId = attached.result.sessionId;
		await client.send("Page.enable", {}, sessionId);
		await client.send("Runtime.enable", {}, sessionId);
		await client.send("Page.navigate", { url }, sessionId);
		await sleep(minWaitMs);
		let loaded = false;
		const maxIterations = Math.ceil(maxWaitMs / 1000);
		for (let i = 0; i < maxIterations; i += 1) {
			await sleep(1000);
			const ready = await client.send("Runtime.evaluate", {
				returnByValue: true,
				expression: waitExpression,
			}, sessionId);
			if (ready.result?.result?.value) {
				loaded = true;
				break;
			}
			if (diagnostic && i % 10 === 0) {
				const diag = await client.send("Runtime.evaluate", {
					returnByValue: true,
					expression: `JSON.stringify({ title: document.title, bodyLen: (document.body?.innerText || '').length, bodyPreview: (document.body?.innerText || '').slice(0, 200), url: location.href })`,
				}, sessionId);
				console.error(`[CDP diagnostic] ${url}:`, diag.result?.result?.value || 'no value');
			}
		}
		if (!loaded) {
			if (diagnostic) {
				const diag = await client.send("Runtime.evaluate", {
					returnByValue: true,
					expression: `JSON.stringify({ title: document.title, bodyLen: (document.body?.innerText || '').length, bodyPreview: (document.body?.innerText || '').slice(0, 500), url: location.href })`,
				}, sessionId);
				console.error(`[CDP FINAL diagnostic] ${url}:`, diag.result?.result?.value || 'no value');
			}
			throw new Error(`Timed out waiting for page listing content (waited ${maxIterations}s)`);
		}
		const result = await client.send("Runtime.evaluate", { returnByValue: true, expression: evaluateExpression }, sessionId);
		if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text || "CDP evaluate failed");
		return result.result?.result?.value;
	} finally {
		if (targetId) await client.send("Target.closeTarget", { targetId }).catch(() => {});
		await closeCdpBrowser();
	}
}

function inWindow(item, input) {
	const ms = Date.parse(item.publishedAt);
	return Number.isFinite(ms) && ms >= input.startMs && ms < input.endMs;
}

function isDeviceRelated(item) {
	return DEVICE_TERMS.test(`${item.title}\n${item.feedExcerpt}\n${item.url}`);
}

function isStrongDeviceRelated(item) {
	return STRONG_DEVICE_TERMS.test(`${item.title}\n${item.feedExcerpt}\n${item.url}`);
}

function parseSequel(html, source) {
	const items = [];
	for (const match of html.matchAll(/<div role="listitem" class="w-dyn-item">([\s\S]*?)(?=<div role="listitem" class="w-dyn-item">|<\/div><div role="navigation")/g)) {
		const block = match[1];
		const href = attrValue(block.match(/<a\b[\s\S]*?<\/a>/i)?.[0] || "", "href");
		const date = stripHtml(block.match(/<div class="highlighted-text heading4 fw-bold">([\s\S]*?)<\/div>/i)?.[1] || "");
		const title = stripHtml(block.match(/<div class="heading3">([\s\S]*?)<\/div>/i)?.[1] || "");
		const afterTitle = block.split(/<div class="heading3">[\s\S]*?<\/div>/i)[1] || "";
		const summary = shortText(afterTitle.match(/<div>([\s\S]*?)<\/div>/i)?.[1] || "");
		const publishedAt = toIso(date);
		const url = normalizeUrl(href, source.url);
		if (title && publishedAt && url) {
			items.push({ source: source.source, title, publishedAt, url, feedExcerpt: summary, isDeviceRelated: true, id: url });
		}
	}
	return items.filter(isDeviceRelated);
}

function parseRss(xml, source) {
	const items = [];
	for (const match of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
		const block = match[0];
		const title = stripHtml(tagValue(block, "title"));
		const url = normalizeUrl(tagValue(block, "link"), source.url);
		const publishedAt = toIso(tagValue(block, "pubDate") || tagValue(block, "publishDate"));
		const feedExcerpt = shortText(tagValue(block, "description"));
		const id = tagValue(block, "guid") || url;
		if (title && url && publishedAt) items.push({ source: source.source, title, publishedAt, url, feedExcerpt, isDeviceRelated: true, id });
	}
	return items.filter(isDeviceRelated);
}

async function collectQ4Cdp(source, input) {
	const rows = await withCdpPage(source.url, `(() => [...document.querySelectorAll('.evergreen-news-item')].map((row) => {
		const date = row.querySelector('.evergreen-news-date')?.innerText?.trim() || '';
		const link = row.querySelector('a.evergreen-news-headline-link');
		return {
			title: link?.innerText?.trim() || '',
			url: link?.href || '',
			date,
		};
	}).filter((item) => item.title && item.url && item.date))()`, "document.querySelectorAll('a.evergreen-news-headline-link').length > 0");
	const items = (Array.isArray(rows) ? rows : []).map((item) => ({
		source: source.source,
		title: item.title,
		publishedAt: toIso(item.date),
		url: normalizeUrl(item.url, source.url),
		feedExcerpt: "Official investor-relations news listing recovered via CDP.",
		isDeviceRelated: true,
		id: normalizeUrl(item.url, source.url),
	})).filter(isStrongDeviceRelated);
	const results = items.filter((item) => inWindow(item, input));
	return {
		status: { source: source.source, filter: source.filter, mode: source.mode, ok: true, queryUrl: source.url, itemCount: items.length, matchedCount: results.length },
		results,
	};
}

async function collectMassDeviceCdp(source, input) {
	const rows = await withCdpPage(source.url, `(() => [...document.querySelectorAll('article')].map((article) => {
		const text = article.innerText || '';
		const link = article.querySelector('h2 a, h3 a, .entry-title a, a[href*="massdevice.com"]');
		const date = text.match(/[A-Z]+ \\d{1,2}, \\d{4}/)?.[0] || '';
		const summary = text.split(/\\n\\s*FILED UNDER:/i)[0].split(/\\n\\s*[A-Z]+ \\d{1,2}, \\d{4} BY [^\\n]+\\n/i)[1] || '';
		return {
			title: link?.innerText?.trim() || '',
			url: link?.href || '',
			date,
			summary: summary.trim(),
		};
	}).filter((item) => item.title && item.url && item.date))()`, "document.querySelectorAll('article').length > 0");
	const items = (Array.isArray(rows) ? rows : []).map((item) => ({
		source: source.source,
		title: item.title,
		publishedAt: toIso(item.date),
		url: normalizeUrl(item.url, source.url),
		feedExcerpt: shortText(item.summary),
		isDeviceRelated: true,
		id: normalizeUrl(item.url, source.url),
	})).filter(isStrongDeviceRelated);
	const results = items.filter((item) => inWindow(item, input));
	return {
		status: { source: source.source, filter: source.filter, mode: source.mode, ok: true, queryUrl: source.url, itemCount: items.length, matchedCount: results.length },
		results,
	};
}

async function collectMobiCdp(source, input) {
	const page = await withCdpPage(source.url, `(() => {
		const body = document.body?.innerText || '';
		const links = [...document.querySelectorAll('a[href*="/news/"]')].map((link) => ({ title: link.innerText.trim(), url: link.href })).filter((item) => item.title && item.url);
		return { body, links, title: document.title || '', url: location.href };
	})()`, "document.body && document.body.innerText && document.body.innerText.includes('Dexcom') && document.querySelectorAll('a[href*=\"/news/\"]').length > 0", { diagnostic: true, minWaitMs: 8000, maxWaitMs: 30000 });
	const bodyText = String(page?.body || "");
	if (!bodyText || bodyText.length < 50) {
		console.error(`[MobiHealthNews] body too short (${bodyText.length} chars), page may be blocked or empty`);
		return {
			status: { source: source.source, filter: source.filter, mode: source.mode, ok: false, queryUrl: source.url, itemCount: 0, matchedCount: 0, error: `Body too short (${bodyText.length} chars), likely blocked or empty page` },
			results: [],
		};
	}
	const lines = bodyText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
	const seen = new Set();
	const items = (Array.isArray(page?.links) ? page.links : []).flatMap((link) => {
		if (seen.has(link.url)) return [];
		seen.add(link.url);
		const index = lines.indexOf(link.title);
		const meta = index >= 0 ? lines.slice(index + 1, index + 4).find((line) => /\|\s*[A-Za-z]+ \d{1,2}, \d{4}/.test(line)) : "";
		const date = meta?.match(/[A-Za-z]+ \d{1,2}, \d{4}/)?.[0] || "";
		const summary = index >= 0 ? lines.slice(index + 1, index + 5).find((line) => line !== meta && !line.startsWith("By ")) : "";
		if (!date) return [];
		return [{
			source: source.source,
			title: link.title,
			publishedAt: toIso(date),
			url: normalizeUrl(link.url, source.url),
			feedExcerpt: shortText(summary),
			isDeviceRelated: true,
			id: normalizeUrl(link.url, source.url),
		}];
	}).filter(isStrongDeviceRelated);
	if (!items.length) {
		return {
			status: { source: source.source, filter: source.filter, mode: source.mode, ok: false, queryUrl: source.url, itemCount: 0, matchedCount: 0, error: "No MobiHealthNews news links found after CDP load" },
			results: [],
		};
	}
	const results = items.filter((item) => inWindow(item, input));
	console.error(`[MobiHealthNews] found ${items.length} items, ${results.length} in window`);
	return {
		status: { source: source.source, filter: source.filter, mode: source.mode, ok: true, queryUrl: source.url, itemCount: items.length, matchedCount: results.length },
		results,
	};
}

async function collectSource(source, input) {
	try {
		if (source.mode === "q4Cdp") return await collectQ4Cdp(source, input);
		if (source.mode === "massdeviceCdp") return await collectMassDeviceCdp(source, input);
		if (source.mode === "mobiCdp") return await collectMobiCdp(source, input);
		const text = await fetchText(source.url);
		let items = [];
		if (source.mode === "sequelHtml") items = parseSequel(text, source);
		if (source.mode === "rss") items = parseRss(text, source);
		const results = items.filter((item) => inWindow(item, input));
		return { status: { source: source.source, filter: source.filter, mode: source.mode, ok: true, queryUrl: source.url, itemCount: items.length, matchedCount: results.length }, results };
	} catch (error) {
		return { status: { source: source.source, filter: source.filter, mode: source.mode, ok: false, queryUrl: source.url, itemCount: 0, matchedCount: 0, error: error.message || String(error) }, results: [] };
	}
}

function shouldRetrySource(entry) {
	const status = entry?.status || {};
	if (status.ok !== true) return true;
	return CDP_MODES.has(status.mode) && Number(status.itemCount || 0) < 1;
}

async function collectSourcesWithRetry(input) {
	const collected = [];
	for (const source of SOURCES) collected.push(await collectSource(source, input));
	const retrySources = SOURCES.filter((source, index) => shouldRetrySource(collected[index]));
	if (retrySources.length === 0) return collected;
	console.error(`[source retry] retrying failed sources only: ${retrySources.map((source) => source.filter).join(", ")}`);
	for (const source of retrySources) {
		const index = SOURCES.findIndex((item) => item.filter === source.filter);
		const firstStatus = collected[index].status;
		const retry = await collectSource(source, input);
		retry.status.attempts = 2;
		retry.status.firstAttempt = {
			ok: firstStatus.ok,
			itemCount: firstStatus.itemCount,
			matchedCount: firstStatus.matchedCount,
			error: firstStatus.error,
		};
		collected[index] = retry;
	}
	return collected;
}

function selfTest() {
	const cases = [
		[{ status: { ok: false, mode: "q4Cdp", itemCount: 0 } }, true],
		[{ status: { ok: true, mode: "q4Cdp", itemCount: 0 } }, true],
		[{ status: { ok: true, mode: "q4Cdp", itemCount: 3 } }, false],
		[{ status: { ok: true, mode: "rss", itemCount: 0 } }, false],
	];
	for (const [entry, expected] of cases) {
		if (shouldRetrySource(entry) !== expected) throw new Error(`shouldRetrySource self-test failed: ${JSON.stringify(entry)}`);
	}
}

function dedupeAndSort(results, maxItems) {
	const seen = new Set();
	return results
		.filter((item) => {
			const key = item.id || item.url;
			if (!key || seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.source.localeCompare(b.source) || a.title.localeCompare(b.title))
		.slice(0, maxItems);
}

function countBy(items, field) {
	const counts = {};
	for (const item of items) counts[item[field]] = (counts[item[field]] || 0) + 1;
	return counts;
}

if (process.env.UGK_COLLECTOR_SELFTEST === "1") {
	selfTest();
	console.log("PASS");
	process.exit(0);
}

let runLockAcquired = false;
try {
	const input = readInput();
	const outputDir = process.env.TASK_OUTPUT_DIR || die("TASK_OUTPUT_DIR is required");
	await acquireRunLock();
	runLockAcquired = true;
	const collected = await collectSourcesWithRetry(input);
	const sourceStatus = collected.map((entry) => entry.status);
	const results = dedupeAndSort(collected.flatMap((entry) => entry.results), input.maxItems);

	const data = {
		task: "diabetes-device-custom-source-news",
		retrievedAt: new Date().toISOString(),
		timeWindow: {
			raw: input.timePhrase,
			days: input.days,
			startIso: input.startIso,
			endIso: input.endIso,
		},
		sources: SOURCES,
		sourceStatus,
		summary: {
			totalSources: sourceStatus.length,
			successfulSources: sourceStatus.filter((item) => item.ok).length,
			blockedSources: sourceStatus.filter((item) => !item.ok).length,
			totalFetched: sourceStatus.reduce((sum, item) => sum + Number(item.itemCount || 0), 0),
			totalMatches: results.length,
			bySource: countBy(results, "source"),
		},
		results,
	};

	await mkdir(outputDir, { recursive: true });
	await writeFile(join(outputDir, JSON_NAME), JSON.stringify(data, null, 2) + "\n", "utf8");
	console.log(`Wrote ${results.length} phase 3 source news items to ${outputDir}`);
} finally {
	await closeCdpBrowser();
	if (runLockAcquired) await releaseRunLock();
}
