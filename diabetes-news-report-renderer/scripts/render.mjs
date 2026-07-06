import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const HTML_NAME = "diabetes_news_report.html";

function die(message) {
	console.error(message);
	process.exit(1);
}

function normalizeTargetLanguage(value, pack) {
	const raw = String(value || pack.targetLanguage || "").trim();
	if (!raw || /^(original|source|raw|none|原文)$/i.test(raw)) return "original";
	if (/^(zh|zh-cn|chinese|中文|简体中文|中文版|中文版本)$/i.test(raw)) return "zh-CN";
	return raw;
}

function readInput() {
	let input;
	try {
		input = JSON.parse(process.env.TASK_INPUT || "{}");
	} catch (error) {
		die(`TASK_INPUT is not valid JSON: ${error.message}`);
	}
	if (!input.packPath) die("TASK_INPUT.packPath is required");
	return {
		packPath: resolve(String(input.packPath)),
		targetLanguageRaw: input.targetLanguage,
		title: String(input.title || "").trim(),
	};
}

function escapeHtml(value) {
	return String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function dateMinute(value) {
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) return "";
	const iso = new Date(ms).toISOString();
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function labels(zh, title) {
	return zh ? {
		title: title || "糖尿病医疗新闻汇总报告",
		retrieved: "生成时间",
		inputs: "输入文件",
		total: "去重条目",
		device: "器械/监管重点",
		overview: "采集概况",
		highlights: "重点项目概括",
		list: "全部新闻列表",
		sources: "采集渠道",
		time: "时间",
		itemTitle: "标题",
		source: "平台",
		type: "类型",
		summary: "摘要",
		status: "状态",
		count: "匹配/候选",
		query: "查询",
		none: "没有可渲染条目。",
		sortRule: "排序规则",
		sortRuleValue: "列表按时间倒序；重点按器械/监管优先",
	} : {
		title: title || "Diabetes Medical News Report",
		retrieved: "Generated",
		inputs: "Input Files",
		total: "Deduped Items",
		device: "Device/Regulatory Focus",
		overview: "Collection Overview",
		highlights: "Key Highlights",
		list: "All News",
		sources: "Source Channels",
		time: "Time",
		itemTitle: "Title",
		source: "Source",
		type: "Type",
		summary: "Summary",
		status: "Status",
		count: "Matched/Fetched",
		query: "Query",
		none: "No renderable items.",
		sortRule: "Sort Rule",
		sortRuleValue: "News list newest first; highlights prioritize device/regulatory items",
	};
}

function zhType(type) {
	return ({
		"510k": "510(k)获批",
		recall: "召回信号",
		enforcement: "执法记录",
		trial: "临床试验",
		"fda-cdrh": "FDA CDRH更新",
		safety: "FDA安全信号",
		conference: "会议信号",
		"device-news": "器械新闻",
		"diabetes-news": "糖尿病新闻",
		regulatory: "监管信号",
	}[type] || "新闻");
}

function displayTitle(item, zh) {
	if (!zh) return item.title;
	if (!item.translatedTitle) die(`Missing translatedTitle for ${item.itemId}`);
	return item.translatedTitle;
}

function displaySummary(item, zh) {
	if (!zh) return item.summary || item.source;
	if (!item.translatedSummary) die(`Missing translatedSummary for ${item.itemId}`);
	return item.translatedSummary;
}

function renderHtml({ pack, input, targetLanguage }) {
	const zh = targetLanguage === "zh-CN";
	const title = input.title || (zh ? pack.translatedTitle : "") || pack.title || "";
	const l = labels(zh, title);
	const items = Array.isArray(pack.items) ? pack.items : [];
	const byId = new Map(items.map((item) => [item.itemId, item]));
	const highlights = (Array.isArray(pack.highlights) ? pack.highlights.map((id) => byId.get(id)).filter(Boolean) : items.slice(0, 8)).slice(0, 8);
	const sourceStatus = Array.isArray(pack.sourceStatus) ? pack.sourceStatus : [];
	const typeText = (item) => zh ? zhType(item.type) : item.type;
	const highlightRows = highlights.map((item) => `
					<li>
						<div class="item-meta">${escapeHtml(dateMinute(item.date))} · ${escapeHtml(item.source)} · ${escapeHtml(typeText(item))}</div>
						<a class="headline-title" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(displayTitle(item, zh))}</a>
						<p class="headline-summary">${escapeHtml(displaySummary(item, zh))}</p>
					</li>`).join("");
	const rows = items.map((item) => `
					<tr>
						<td>${escapeHtml(dateMinute(item.date))}</td>
						<td class="news-title"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(displayTitle(item, zh))}</a></td>
						<td>${escapeHtml(item.source)}</td>
						<td>${escapeHtml(typeText(item))}</td>
						<td>${escapeHtml(displaySummary(item, zh))}</td>
					</tr>`).join("");
	const sourceRows = sourceStatus.map((item) => `
					<tr>
						<td>${escapeHtml(item.source)}</td>
						<td>${escapeHtml(item.mode)}</td>
						<td>${escapeHtml(item.ok ? "OK" : "FAIL")}</td>
						<td>${Number(item.matchedCount)} / ${Number(item.itemCount)}</td>
						<td>${item.queryUrl ? `<a href="${escapeHtml(item.queryUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.query)}</a>` : ""}${item.error ? ` - ${escapeHtml(item.error)}` : ""}</td>
					</tr>`).join("");
	const generatedAt = new Date().toISOString();
	const inputCount = Array.isArray(pack.sourceFiles) ? pack.sourceFiles.length : 1;
	const deviceCount = items.filter((item) => Number(item.priority) >= 2).length;
	return `<!doctype html>
<html lang="${zh ? "zh-CN" : "en"}">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${escapeHtml(l.title)}</title>
	<style>
		:root { --ink: #17202a; --muted: #5b6573; --line: #cfd6df; --paper: #ffffff; --bg: #f4f6f8; --accent: #174f8a; --soft: #e9eef4; }
		* { box-sizing: border-box; }
		body { margin: 0; background: var(--bg); color: var(--ink); font-family: Arial, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif; line-height: 1.55; }
		main { max-width: 1220px; margin: 0 auto; padding: 36px 28px 56px; }
		header { border-bottom: 3px solid var(--ink); padding-bottom: 18px; margin-bottom: 24px; }
		h1 { margin: 0 0 8px; font-size: 30px; line-height: 1.15; letter-spacing: 0; }
		h2 { margin: 32px 0 12px; font-size: 20px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
		.meta-grid, .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
		.meta, .stat { background: var(--paper); border: 1px solid var(--line); border-radius: 2px; padding: 12px; }
		.label { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
		.value { font-size: 16px; font-weight: 700; }
		table { width: 100%; border-collapse: collapse; background: var(--paper); border: 1px solid var(--line); }
		th, td { border-bottom: 1px solid var(--line); padding: 9px 10px; text-align: left; vertical-align: top; font-size: 14px; }
		th { background: var(--soft); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
		a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
		.highlight-list { margin: 0; padding-left: 20px; }
		.highlight-list li { margin: 0 0 12px; padding-left: 4px; }
		.item-meta { color: var(--muted); font-size: 13px; }
		.headline-summary { margin: 4px 0 0; color: var(--ink); font-size: 14px; }
		.empty { background: var(--paper); border: 1px solid var(--line); padding: 14px; }
		td:nth-child(1) { white-space: nowrap; width: 145px; }
		td:nth-child(3) { width: 180px; }
		td:nth-child(4) { width: 120px; }
	</style>
</head>
<body>
	<main>
		<header>
			<h1>${escapeHtml(l.title)}</h1>
			<div class="meta-grid">
				<div class="meta"><span class="label">${escapeHtml(l.retrieved)}</span><span class="value">${escapeHtml(generatedAt.slice(0, 10))}</span></div>
				<div class="meta"><span class="label">${escapeHtml(l.inputs)}</span><span class="value">${inputCount}</span></div>
				<div class="meta"><span class="label">${escapeHtml(l.total)}</span><span class="value">${items.length}</span></div>
				<div class="meta"><span class="label">${escapeHtml(l.device)}</span><span class="value">${deviceCount}</span></div>
			</div>
		</header>

		<section>
			<h2>${escapeHtml(l.overview)}</h2>
			<div class="stat-grid">
				<div class="stat"><span class="label">${escapeHtml(l.inputs)}</span><span class="value">${escapeHtml((pack.inputTasks || []).join(", "))}</span></div>
				<div class="stat"><span class="label">${escapeHtml(l.sources)}</span><span class="value">${sourceStatus.filter((item) => item.ok).length}/${sourceStatus.length}</span></div>
				<div class="stat"><span class="label">${escapeHtml(l.sortRule)}</span><span class="value">${escapeHtml(l.sortRuleValue)}</span></div>
			</div>
		</section>

		<section>
			<h2>${escapeHtml(l.highlights)}</h2>
			<ol class="highlight-list">
${highlightRows || `				<li>${escapeHtml(l.none)}</li>`}
			</ol>
		</section>

		<section>
			<h2>${escapeHtml(l.list)}</h2>
			${rows ? `<table>
				<thead><tr><th>${escapeHtml(l.time)}</th><th>${escapeHtml(l.itemTitle)}</th><th>${escapeHtml(l.source)}</th><th>${escapeHtml(l.type)}</th><th>${escapeHtml(l.summary)}</th></tr></thead>
				<tbody>
${rows}
				</tbody>
			</table>` : `<div class="empty">${escapeHtml(l.none)}</div>`}
		</section>

		<section>
			<h2>${escapeHtml(l.sources)}</h2>
			<table>
				<thead><tr><th>${escapeHtml(l.source)}</th><th>${escapeHtml(l.type)}</th><th>${escapeHtml(l.status)}</th><th>${escapeHtml(l.count)}</th><th>${escapeHtml(l.query)}</th></tr></thead>
				<tbody>
${sourceRows}
				</tbody>
			</table>
		</section>
	</main>
</body>
</html>
`;
}

const input = readInput();
const outputDir = process.env.TASK_OUTPUT_DIR || die("TASK_OUTPUT_DIR is required");
const pack = JSON.parse(await readFile(input.packPath, "utf8"));
if (!Array.isArray(pack.items)) die("pack.items must be an array");
const targetLanguage = normalizeTargetLanguage(input.targetLanguageRaw, pack);
if (targetLanguage === "zh-CN" && pack.targetLanguage !== "zh-CN") die("zh-CN rendering requires translated pack from diabetes-news-report-translator");

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, HTML_NAME), renderHtml({ pack, input, targetLanguage }), "utf8");
console.log(`Wrote ${pack.items.length} packed items to ${join(outputDir, HTML_NAME)}`);
