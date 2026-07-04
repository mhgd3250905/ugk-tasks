// collect-and-write.mjs — x-search 的数据落地脚本。
// ponytail: 替代 worker 用 write tool 逐 token 输出 JSON 的慢路径。
// worker 只 bash 调一次:node 直连 CDP 取 rows → 组装 envelope → writeFileSync → round-trip 自检。
// LLM 完全不碰 rows 内容(根治慢写 + JSON 合法性两病)。
//
// 用法(单行 bash,worker 调):
//   node "$TASK_DIR/scripts/collect-and-write.mjs" \
//     --rawQuery "<原始 keyword>" --normalizedKeyword "<keyword>" \
//     --timeWindow '<timeWindow JSON 7字段>' --cutoffIso "<startIso>" \
//     --searchUrl "<URL>" --benchmark '<benchmark JSON,含 worker 算的 score/grade 等>' \
//     --output "$TASK_OUTPUT_DIR/x_search_results.json"
//
// 取数:循环 evaluate dump-result.js(offset += 100,source 默认 rows 即时间窗内+关键词命中全集)。
// timeWindow/benchmark 是小 JSON,经 argv 传入(经 LLM,但不是 rows,无开销问题)。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createCdpClient } from "./cdp-client.mjs";

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith("--")) {
			const key = argv[i].slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; }
			else out[key] = "true";
		}
	}
	return out;
}

const str = (x) => String(x ?? "");
const num0 = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

const DUMP_SCRIPT = readFileSync(new URL("./dump-result.js", import.meta.url), "utf8");
// ponytail: 剥掉头部注释行。否则拼接 `return //comment\n IIFE` 时,// 注释吞掉 return
// 的值(JS ASI:return 后跟注释→return;→返回 undefined)。CDP evaluate 单表达式经典坑。
const DUMP_CLEAN = DUMP_SCRIPT.replace(/^\/\/.*$/gm, "").trim();

async function collectAllRows(tab, evaluate, source = "rows") {
	const all = [];
	let offset = 0;
	const limit = 100;
	let safety = 0;
	while (safety++ < 100) {
		// 分号分隔(不用 return 包裹),整个表达式值 = IIFE 返回值。
		const expr = `window.__xSearcherDumpConfig = { source: ${JSON.stringify(source)}, offset: ${offset}, limit: ${limit} }; ${DUMP_CLEAN}`;
		const chunk = await evaluate(tab, expr, { timeoutMs: 30000 });
		if (chunk === undefined || chunk === null) {
			throw new Error(`dump evaluate 返回 ${String(chunk)}(collector 是否还在?tab 是否被回收?)`);
		}
		if (chunk.ok === false) throw new Error(`dump 返回 ok:false at offset ${offset}: ${JSON.stringify(chunk).slice(0, 200)}`);
		if (Array.isArray(chunk.rows)) all.push(...chunk.rows);
		if (chunk.hasMore === false || !chunk.hasMore) break;
		offset += chunk.returned || limit;
		if (!chunk.returned) break;
	}
	return all;
}

// 字段映射:content→text, authorName→author, authorHandle→handle(skill.md line 132)
function mapRow(r) {
	return {
		postedAt: str(r.postedAt),
		text: str(r.content),
		url: str(r.url),
		author: str(r.authorName),
		handle: str(r.authorHandle),
	};
}

function parseJsonArg(raw, name) {
	try { return JSON.parse(raw); }
	catch { throw new Error(`--${name} 不是合法 JSON: ${String(raw).slice(0, 200)}`); }
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	for (const k of ["rawQuery", "normalizedKeyword", "timeWindow", "cutoffIso", "searchUrl", "benchmark", "output"]) {
		if (!args[k] || args[k] === "true") throw new Error(`missing --${k}`);
	}
	// 先校验 + parse 所有 argv(快失败,避免无谓 CDP 连接)
	const timeWindow = parseJsonArg(args.timeWindow, "timeWindow");
	let benchmark = parseJsonArg(args.benchmark, "benchmark");

	const cdp = createCdpClient();
	const tab = await cdp.findTab({ urlContains: "x.com/search" });
	const source = args.source === "allRows" ? "allRows" : "rows";
	const rows = await collectAllRows(tab, cdp.evaluate.bind(cdp), source);
	// rowsReturned 以 node 实取为准(防 worker 误传)
	benchmark = { ...benchmark, rowsReturned: rows.length };

	const envelope = {
		rawQuery: str(args.rawQuery),
		normalizedKeyword: str(args.normalizedKeyword),
		timeWindow,
		cutoffIso: str(args.cutoffIso),
		retrievedAt: new Date().toISOString(),
		searchUrl: str(args.searchUrl),
		method: "x-search taskbook / DOM fallback with MutationObserver + anchor-overlap scrolling / local Chrome CDP",
		benchmark,
		results: rows.map(mapRow),
	};

	const output = str(args.output);
	mkdirSync(dirname(output), { recursive: true });
	const text = JSON.stringify(envelope, null, 2);
	writeFileSync(output, text, "utf8");

	try { JSON.parse(readFileSync(output, "utf8")); }
	catch (e) { throw new Error(`round-trip JSON 校验失败: ${e.message}`); }

	console.log(`x-search collect-and-write: ${rows.length} rows, ${text.length} bytes → ${output}`);
}

main().catch((e) => { console.error("collect-and-write FAILED:", e.message); process.exit(1); });
