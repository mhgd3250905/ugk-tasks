import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const JSON_NAME = "medical_diabetes_news.json";

const SOURCES = [
	{ name: "Healio", mode: "rss", domain: /^https:\/\/www\.healio\.com\//, feeds: ["https://www.healio.com/sws/feed/news/endocrinology"] },
	{ name: "BioSpace", mode: "rss", domain: /^https:\/\/www\.biospace\.com\//, feeds: ["https://www.biospace.com/all-news.rss", "https://www.biospace.com/drug-development.rss"] },
	{ name: "STAT News", mode: "rss", domain: /^https:\/\/www\.statnews\.com\//, feeds: ["https://www.statnews.com/category/pharma/feed", "https://www.statnews.com/category/biotech/feed", "https://www.statnews.com/category/health-tech/feed"] },
	{ name: "Reuters", mode: "reutersNewsSitemap", domain: /^https:\/\/www\.reuters\.com\//, feeds: ["https://www.reuters.com/arc/outboundfeeds/news-sitemap-index/?outputType=xml"] },
	{ name: "Fierce Biotech", mode: "rss", domain: /^https:\/\/www\.fiercebiotech\.com\//, feeds: ["https://www.fiercebiotech.com/rss/xml", "https://www.fiercebiotech.com/rss/medtech/xml"] },
	{ name: "Fierce Pharma", mode: "rss", domain: /^https:\/\/www\.fiercepharma\.com\//, feeds: ["https://www.fiercepharma.com/rss/xml"] },
	{ name: "MedTech Dive", mode: "rss", domain: /^https:\/\/www\.medtechdive\.com\//, feeds: ["https://www.medtechdive.com/feeds/news/"] },
	{ name: "Eli Lilly IR", mode: "rss", domain: /^https:\/\/investor\.lilly\.com\//, feeds: ["https://investor.lilly.com/rss/news-releases.xml?items=50"] },
	{ name: "Drug Delivery Business News", mode: "rss", domain: /^https:\/\/www\.drugdeliverybusiness\.com\//, feeds: [
		"https://www.drugdeliverybusiness.com/feed/",
		"https://www.drugdeliverybusiness.com/category/diabetes-etc/feed/",
		"https://www.drugdeliverybusiness.com/tag/medtrum/feed/",
		"https://www.drugdeliverybusiness.com/tag/tandem-diabetes-care/feed/",
		"https://www.drugdeliverybusiness.com/tag/trinity-biotech/feed/",
		"https://www.drugdeliverybusiness.com/tag/minimed/feed/",
		"https://www.drugdeliverybusiness.com/tag/beta-bionics/feed/",
		"https://www.drugdeliverybusiness.com/tag/dexcom/feed/",
		"https://www.drugdeliverybusiness.com/tag/insulet/feed/",
		"https://www.drugdeliverybusiness.com/tag/abbott/feed/",
		"https://www.drugdeliverybusiness.com/tag/ypsomed/feed/"
	] },
	{ name: "Medical Device Network", mode: "rss", domain: /^https:\/\/www\.medicaldevice-network\.com\//, feeds: ["https://www.medicaldevice-network.com/feed/"] },
	{ name: "Diabetotech", mode: "rss", domain: /^https:\/\/www\.diabetotech\.com\//, feeds: ["https://www.diabetotech.com/blog.rss"] },
	{ name: "Abbott Newsroom", mode: "rss", domain: /^https:\/\/abbott\.mediaroom\.com\//, feeds: ["https://abbott.mediaroom.com/press-releases?pagetemplate=rss", "https://abbott.mediaroom.com/press-releases?category=781&pagetemplate=rss"] },
	{ name: "Sanofi US News", mode: "rss", domain: /^https:\/\/www\.news\.sanofi\.us\//, feeds: ["https://www.news.sanofi.us/press-releases?pagetemplate=rss", "https://www.news.sanofi.us/press-releases?category=785&pagetemplate=rss"] },
	{ name: "MiniMed Newsroom", mode: "rss", domain: /^https:\/\/news\.minimed\.com\//, feeds: ["https://news.minimed.com/press-releases?pagetemplate=rss"] },
	{ name: "Medtronic Diabetes", mode: "rss", domain: /^https:\/\/news\.medtronic\.com\//, feeds: ["https://news.medtronic.com/press-releases?category=775&pagetemplate=rss"] },
	{ name: "Tandem Diabetes Care IR", mode: "rss", domain: /^https:\/\/investor\.tandemdiabetes\.com\//, feeds: ["https://investor.tandemdiabetes.com/rss/news-releases.xml?items=50"] },
	{ name: "Beta Bionics IR", mode: "rss", domain: /^https:\/\/investors\.betabionics\.com\//, feeds: ["https://investors.betabionics.com/rss/news-releases.xml?items=50"] },
	{ name: "embecta IR", mode: "rss", domain: /^https:\/\/investors\.embecta\.com\//, feeds: ["https://investors.embecta.com/rss/news-releases.xml?items=50"] },
	{ name: "Medical Design & Outsourcing", mode: "rss", domain: /^https:\/\/www\.medicaldesignandoutsourcing\.com\//, feeds: ["https://www.medicaldesignandoutsourcing.com/category/diabetes/feed/"] },
	{ name: "MedTech Intelligence", mode: "rss", domain: /^https:\/\/medtechintelligence\.com\//, feeds: ["https://medtechintelligence.com/feed/"] },
	{ name: "Tidepool Blog", mode: "rss", domain: /^https:\/\/www\.tidepool\.org\//, feeds: ["https://www.tidepool.org/blog/rss.xml"] },
	{ name: "Glooko", mode: "rss", domain: /^https:\/\/glooko\.com\//, feeds: ["https://glooko.com/feed/"] },
	{ name: "Diabeloop", mode: "rss", domain: /^https:\/\/www\.diabeloop\.com\//, feeds: ["https://www.diabeloop.com/feed/"] },
	{ name: "PR Newswire Health", mode: "rss", domain: /^https:\/\/www\.prnewswire\.com\//, feeds: ["https://www.prnewswire.com/rss/health-news-releases-list.rss"] },
	{ name: "FDA CDRH New", mode: "fdaCdrhNewHtml", domain: /^https:\/\/www\.fda\.gov\//, feeds: ["https://www.fda.gov/medical-devices/medical-devices-news-and-events/cdrh-new-news-and-updates"] }
];

const DIABETES_TERMS = [
	"diabetes",
	"diabetic",
	"type 1",
	"type 2",
	"t1d",
	"t2d",
	"hba1c",
	"a1c",
	"insulin",
	"glucose",
	"glycemic",
	"hypoglycemia",
	"hyperglycemia",
	"diabetic retinopathy",
	"tzield"
];

const DEVICE_TERMS = [
	"cgm",
	"continuous glucose monitor",
	"continuous glucose monitoring",
	"glucose monitor",
	"insulin pump",
	"automated insulin delivery",
	"closed-loop",
	"closed loop",
	"hybrid closed loop",
	"smart insulin pen",
	"sensor",
	"wearable",
	"medical device",
	"digital health",
	"remote monitoring",
	"artificial pancreas",
	"pump",
	"freestyle libre",
	"libre",
	"dexcom",
	"eversense",
	"omnipod",
	"minimed",
	"tandem diabetes",
	"t:slim",
	"control-iq",
	"mobi",
	"inpen",
	"ilet",
	"beta bionics",
	"patch pump",
	"tidepool loop",
	"camaps",
	"twiist",
	"medtrum",
	"touchcare",
	"trinity biotech",
	"cgm+",
	"stelo",
	"ypsomed",
	"mylife diabetes"
];

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
	return { timePhrase: String(input.timePhrase), days, startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString(), startMs, endMs, maxItems };
}

function xmlDecode(value) {
	return String(value || "")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function stripHtml(value) {
	return xmlDecode(value)
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function cleanFeedExcerpt(...values) {
	for (const value of values) {
		let text = stripHtml(value)
			.replace(/\s*The post .+? appeared first on .+?\.?\s*$/i, "")
			.replace(/\s*\[(?:…|\.{3})\]\s*/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		const sentenceCut = Math.max(text.lastIndexOf("."), text.lastIndexOf("!"), text.lastIndexOf("?"), text.lastIndexOf("。"));
		if (sentenceCut > 180 && sentenceCut < text.length - 1) text = text.slice(0, sentenceCut + 1);
		if (text && text.length > 420) {
			const head = text.slice(0, 420);
			const cut = Math.max(head.lastIndexOf("."), head.lastIndexOf("!"), head.lastIndexOf("?"), head.lastIndexOf("。"));
			return cut > 180 ? head.slice(0, cut + 1) : `${head.slice(0, 417).trimEnd()}...`;
		}
		if (text) return text;
	}
	return "";
}

function tagValue(block, tag) {
	const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
	return match ? xmlDecode(match[1]).trim() : "";
}

function attrValue(block, tag, attr) {
	const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = block.match(new RegExp(`<${escapedTag}\\b[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, "i"));
	return match ? xmlDecode(match[1]).trim() : "";
}

function parseRss(xml, source, feedUrl) {
	const items = [];
	for (const match of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
		const block = match[0];
		const url = tagValue(block, "link") || tagValue(block, "guid");
		const rawDate = tagValue(block, "pubDate") || tagValue(block, "dc:date") || tagValue(block, "updated");
		items.push({
			source: source.name,
			sourceFeed: feedUrl,
			title: stripHtml(tagValue(block, "title")),
			url,
			publishedAt: toIso(rawDate),
			feedExcerpt: cleanFeedExcerpt(tagValue(block, "description"), tagValue(block, "content:encoded")),
			_text: `${tagValue(block, "title")}\n${tagValue(block, "description")}\n${tagValue(block, "content:encoded")}\n${url}`
		});
	}
	for (const match of xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
		const block = match[0];
		const url = attrValue(block, "link", "href") || tagValue(block, "link") || tagValue(block, "id");
		const rawDate = tagValue(block, "published") || tagValue(block, "updated");
		items.push({
			source: source.name,
			sourceFeed: feedUrl,
			title: stripHtml(tagValue(block, "title")),
			url,
			publishedAt: toIso(rawDate),
			feedExcerpt: cleanFeedExcerpt(tagValue(block, "summary"), tagValue(block, "content")),
			_text: `${tagValue(block, "title")}\n${tagValue(block, "summary")}\n${tagValue(block, "content")}\n${url}`
		});
	}
	return items;
}

function parseReutersNewsSitemap(xml, source, feedUrl) {
	return [...xml.matchAll(/<url\b[\s\S]*?<\/url>/gi)].map((match) => {
		const block = match[0];
		const url = tagValue(block, "loc");
		const title = stripHtml(tagValue(block, "news:title"));
		const rawDate = tagValue(block, "news:publication_date") || tagValue(block, "lastmod");
		return {
			source: source.name,
			sourceFeed: feedUrl,
			title,
			url,
			publishedAt: toIso(rawDate),
			feedExcerpt: "",
			_text: `${title}\n${url}`
		};
	});
}

function parseFdaCdrhNewHtml(html, source, feedUrl) {
	const items = [];
	for (const match of html.matchAll(/<h2\b[^>]*>\s*([A-Z][a-z]+ \d{1,2}, \d{4})\s*<\/h2>\s*<ul>([\s\S]*?)<\/ul>/g)) {
		const publishedAt = toIso(match[1]);
		if (!publishedAt) continue;
		for (const link of match[2].matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
			const url = new URL(xmlDecode(link[1]).trim(), feedUrl).href;
			const title = stripHtml(link[2]);
			items.push({
				source: source.name,
				sourceFeed: feedUrl,
				title,
				url,
				publishedAt,
				feedExcerpt: "",
				_text: `${title}\n${url}`
			});
		}
	}
	return items;
}

function toIso(value) {
	const ms = Date.parse(String(value || ""));
	return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function findTerms(text, terms) {
	const haystack = stripHtml(text).toLowerCase().replace(/insulin-like growth factor/g, "growth factor");
	return terms.filter((term) => haystack.includes(term.toLowerCase()));
}

function normalizeUrl(url) {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		return parsed.href.replace(/\/$/, "");
	} catch {
		return String(url || "").trim();
	}
}

async function fetchText(url) {
	const response = await fetch(url, {
		headers: {
			accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5",
			"user-agent": "ugk-medical-diabetes-news/1.0"
		}
	});
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
	return response.text();
}

async function collectSource(source, input) {
	const status = [];
	const items = [];
	for (const feedUrl of source.feeds) {
		try {
			if (source.mode === "reutersNewsSitemap") {
				const indexXml = await fetchText(feedUrl);
				const sitemapUrls = [...indexXml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((match) => xmlDecode(match[1]).trim()).slice(0, 8);
				let feedItems = 0;
				for (const sitemapUrl of sitemapUrls) {
					const sitemapXml = await fetchText(sitemapUrl);
					const parsed = parseReutersNewsSitemap(sitemapXml, source, sitemapUrl);
					feedItems += parsed.length;
					items.push(...parsed);
				}
				status.push({ source: source.name, feedUrl, ok: true, itemCount: feedItems });
				continue;
			}
			if (source.mode === "fdaCdrhNewHtml") {
				const html = await fetchText(feedUrl);
				const parsed = parseFdaCdrhNewHtml(html, source, feedUrl);
				items.push(...parsed);
				status.push({ source: source.name, feedUrl, ok: true, itemCount: parsed.length });
				continue;
			}
			const xml = await fetchText(feedUrl);
			const parsed = parseRss(xml, source, feedUrl);
			items.push(...parsed);
			status.push({ source: source.name, feedUrl, ok: true, itemCount: parsed.length });
		} catch (error) {
			status.push({ source: source.name, feedUrl, ok: false, itemCount: 0, error: error.message || String(error) });
		}
	}
	return { status, items };
}

function isValidSourceUrl(item) {
	const source = SOURCES.find((entry) => entry.name === item.source);
	return source ? source.domain.test(String(item.url || "")) : false;
}

function rankResults(a, b) {
	if (a.isDeviceRelated !== b.isDeviceRelated) return a.isDeviceRelated ? -1 : 1;
	return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
}

function toResult(item) {
	const diabetesTerms = findTerms(item._text, DIABETES_TERMS);
	const deviceTerms = findTerms(item._text, DEVICE_TERMS);
	return {
		source: item.source,
		title: stripHtml(item.title),
		publishedAt: item.publishedAt,
		url: item.url,
		feedExcerpt: cleanFeedExcerpt(item.feedExcerpt),
		isDeviceRelated: deviceTerms.length > 0,
		_diabetesTerms: diabetesTerms,
		_deviceTerms: deviceTerms
	};
}

const input = readInput();
const outputDir = process.env.TASK_OUTPUT_DIR || die("TASK_OUTPUT_DIR is required");
const collected = await Promise.all(SOURCES.map((source) => collectSource(source, input)));
const sourceStatus = collected.flatMap((entry) => entry.status);
const rawItems = collected.flatMap((entry) => entry.items);
const seen = new Set();
const inWindow = rawItems.filter((item) => {
	const key = normalizeUrl(item.url);
	const ms = Date.parse(item.publishedAt);
	if (!key || seen.has(key)) return false;
	seen.add(key);
	return Number.isFinite(ms) && ms >= input.startMs && ms < input.endMs && isValidSourceUrl(item);
});
const results = inWindow
	.map(toResult)
	.filter((item) => item.title && item.url && item._diabetesTerms.length > 0)
	.sort(rankResults)
	.slice(0, input.maxItems)
	.map(({ _diabetesTerms, _deviceTerms, ...item }) => item);

const data = {
	task: "medical-diabetes-news",
	retrievedAt: new Date().toISOString(),
	timeWindow: {
		raw: input.timePhrase,
		days: input.days,
		startIso: input.startIso,
		endIso: input.endIso
	},
	sources: SOURCES.map((source) => ({ name: source.name, mode: source.mode, feeds: source.feeds })),
	sourceStatus,
	summary: {
		totalFeeds: sourceStatus.length,
		successfulFeeds: sourceStatus.filter((item) => item.ok).length,
		totalFeedItems: rawItems.length,
		totalInWindow: inWindow.length,
		totalMatches: results.length,
		deviceRelated: results.filter((item) => item.isDeviceRelated).length,
		diabetesOnly: results.filter((item) => !item.isDeviceRelated).length
	},
	results
};

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, JSON_NAME), JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(`Wrote ${results.length} diabetes news metadata items to ${outputDir}`);
