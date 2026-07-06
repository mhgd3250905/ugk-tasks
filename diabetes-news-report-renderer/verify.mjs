import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HTML_NAME = "diabetes_news_report.html";
const FORBIDDEN_ARTIFACTS = ["diabetes_news_report.json", "diabetes_news_report.md"];

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

function normalizeTargetLanguage(value, pack) {
	const raw = String(value || pack?.targetLanguage || "").trim();
	if (!raw || /^(original|source|raw|none|原文)$/i.test(raw)) return "original";
	if (/^(zh|zh-cn|chinese|中文|简体中文|中文版|中文版本)$/i.test(raw)) return "zh-CN";
	return raw;
}

function normalizeUrl(value) {
	try {
		const url = new URL(String(value || "").replace(/&amp;/g, "&"));
		url.hash = "";
		return url.href.replace(/\/$/, "");
	} catch {
		return String(value || "").trim();
	}
}

function htmlUnescape(value) {
	return String(value || "")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

function cjkCount(text) {
	return (String(text || "").match(/[\u4e00-\u9fff]/g) || []).length;
}

function englishHeavy(text) {
	const value = String(text || "");
	return cjkCount(value) === 0 && /[A-Za-z]{3,}/.test(value) && value.length >= 16;
}

function hasLongSourceLeak(source, html) {
	const normalized = htmlUnescape(html).toLowerCase();
	return String(source || "")
		.split(/[.;:!?()\[\]{}，。；：！？、]/)
		.map((part) => part.replace(/\s+/g, " ").trim())
		.filter((part) => part.length >= 36 && /[A-Za-z]{3,}/.test(part))
		.some((part) => normalized.includes(part.toLowerCase()));
}

function newsLinks(html) {
	return [...html.matchAll(/<td class="news-title">\s*<a href="([^"]+)"/g)].map((match) => normalizeUrl(htmlUnescape(match[1])));
}

const outDir = process.env.TASK_OUTPUT_DIR || ".";
const input = parseJson(process.env.TASK_INPUT || "{}", "TASK_INPUT") || {};
const packPath = input.packPath ? resolve(String(input.packPath)) : "";
const htmlPath = join(outDir, HTML_NAME);

if (!packPath) fail("TASK_INPUT.packPath is required", "path", input.packPath);
if (packPath && !existsSync(packPath)) fail("input pack exists", packPath, "missing");
if (!existsSync(htmlPath)) fail("HTML artifact exists", HTML_NAME, "missing");
for (const name of FORBIDDEN_ARTIFACTS) {
	if (existsSync(join(outDir, name))) fail("renderer emits HTML only", `no ${name}`, "present");
}

const pack = packPath && existsSync(packPath) ? parseJson(readFileSync(packPath, "utf8"), "pack") : null;
const targetLanguage = normalizeTargetLanguage(input.targetLanguage, pack || {});

if (pack && existsSync(htmlPath)) {
	const html = readFileSync(htmlPath, "utf8");
	if (!/^<!doctype html>/i.test(html.trim())) fail("HTML starts with doctype", "<!doctype html>", html.slice(0, 40));
	if (!html.includes('font-family: Arial, "Microsoft YaHei"')) fail("HTML uses fixed report font stack", 'Arial, "Microsoft YaHei"', "missing");
	const zhSections = ["采集概况", "重点项目概括", "全部新闻列表", "采集渠道"];
	const enSections = ["Collection Overview", "Key Highlights", "All News", "Source Channels"];
	for (const section of targetLanguage === "zh-CN" ? zhSections : enSections) {
		if (!html.includes(section)) fail("HTML contains fixed section", section, "missing");
	}
	if (targetLanguage === "zh-CN") {
		if (pack.targetLanguage !== "zh-CN") fail("zh-CN render uses translated pack", "pack.targetLanguage=zh-CN", pack.targetLanguage);
		if (!html.includes('lang="zh-CN"')) fail("HTML language is zh-CN", 'lang="zh-CN"', "missing");
	} else if (!html.includes('lang="en"')) {
		fail("HTML language is en for original output", 'lang="en"', "missing");
	}

	if (!Array.isArray(pack.items)) {
		fail("pack.items is array", "array", typeof pack.items);
	} else {
		const renderedLinks = newsLinks(html);
		if (renderedLinks.length !== pack.items.length) fail("all pack items are rendered once in All News", pack.items.length, renderedLinks.length);
		const seen = new Set();
		for (const [index, url] of renderedLinks.entries()) {
			if (seen.has(url)) fail(`all-news link ${index} is unique`, "unique URL", url);
			seen.add(url);
			if (pack.items[index] && url !== normalizeUrl(pack.items[index].url)) fail(`all-news link ${index} follows pack order`, pack.items[index].url, url);
		}
		for (const [index, item] of pack.items.entries()) {
			if (!renderedLinks.includes(normalizeUrl(item.url))) fail("rendered HTML preserves source URL", item.url, "missing");
			if (targetLanguage === "zh-CN") {
				if (typeof item.translatedTitle !== "string" || !item.translatedTitle.trim()) fail(`items[${index}] has translatedTitle`, "non-empty string", item.translatedTitle);
				if (typeof item.translatedSummary !== "string" || !item.translatedSummary.trim()) fail(`items[${index}] has translatedSummary`, "non-empty string", item.translatedSummary);
				if (englishHeavy(item.title) && cjkCount(item.translatedTitle) < 6) fail(`items[${index}].translatedTitle is readable Chinese`, ">= 6 CJK chars", item.translatedTitle);
				if (englishHeavy(item.summary) && cjkCount(item.translatedSummary) < 8) fail(`items[${index}].translatedSummary is readable Chinese`, ">= 8 CJK chars", item.translatedSummary);
				if (englishHeavy(item.title) && hasLongSourceLeak(item.title, html)) fail(`items[${index}] source title is not leaked as full English`, "translated title in HTML", item.title);
				if (englishHeavy(item.summary) && hasLongSourceLeak(item.summary, html)) fail(`items[${index}] source summary is not leaked as full English`, "translated summary in HTML", item.summary);
			}
		}
	}

	const sourceNames = new Set((pack.sourceStatus || []).map((status) => String(status.source || "")).filter(Boolean));
	for (const source of sourceNames) {
		if (!html.includes(source.replace(/&/g, "&amp;"))) fail("source channel section includes input source", source, "missing");
	}
}

if (failures.length) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
