// collect-and-write.mjs — linkedin-search 的数据落地脚本。
// ponytail: 替代 worker 用 write tool 逐 token 输出 JSON 的慢路径(实测 +124s)。
// worker 只 bash 调一次本脚本:node 直连 CDP 取 rows → 组装 envelope → writeFileSync → round-trip 自检。
// LLM 完全不碰 rows 内容(根治 +124s 和 JSON 合法性两病)。
//
// 用法(单行 bash,worker 调):
//   node "$TASK_DIR/scripts/collect-and-write.mjs" \
//     --keyword "<keyword>" --timePhrase "<timePhrase>" --dateRange <past-24h|past-week|past-month> \
//     --queryUrl "<第0步 URL>" --benchmark '<第5步 scrollStatus JSON>' \
//     --output "$TASK_OUTPUT_DIR/linkedin_search_results.json"
//
// 取数:循环 evaluate dump-result.js(offset += 100),与 worker 旧循环逻辑一致,只是搬到 node 端。
// benchmark / queryUrl 等小字段经 argv 传入(经 LLM,但只是小 JSON,不是 rows)。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createCdpClient } from "./cdp-client.mjs";

// --- argv 解析(支持 --key "value with space",与 worker bash 习惯对齐)---
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

// --- JSON 合法性:字段守卫(防 undefined/null/异常类型破坏 schema)---
const str = (x) => String(x ?? "");
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const num0 = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

// --- 读 dump-result.js 全文作为 evaluate expression ---
// dump-result.js 是 IIFE,读 window.__linkedinCollector.rows。config 在同一表达式里先设。
const DUMP_SCRIPT = readFileSync(new URL("./dump-result.js", import.meta.url), "utf8");

async function collectAllRows(tab, evaluate) {
	const all = [];
	let offset = 0;
	const limit = 100; // dump-result.js 内部 Math.min(100, requestedLimit),用 100 拿满
	let safety = 0;
	// ponytail: 剥掉 DUMP_SCRIPT 头部注释行。否则拼接 `return //comment\n (()=>{})()`
	// 时,// 注释吞掉 return 的值(JS ASI 规则:return 后跟注释→return;→返回 undefined)。
	// 这是 CDP Runtime.evaluate 单表达式模式的经典坑(实测踩中,返回 undefined)。
	const DUMP_CLEAN = DUMP_SCRIPT.replace(/^\/\/.*$/gm, "").trim();
	while (safety++ < 100) {
		// 用分号分隔,不用 return 包裹(避免 return+注释+换行的 ASI 陷阱)。
		// 整个表达式值 = 最后一条语句(IIFE)的返回值。
		const expr = `window.__linkedinDumpConfig = { offset: ${offset}, limit: ${limit} }; ${DUMP_CLEAN}`;
		const chunk = await evaluate(tab, expr, { timeoutMs: 30000 });
		if (chunk === undefined || chunk === null) {
			throw new Error(`dump evaluate 返回 ${String(chunk)}(collector 是否还在?tab 是否被回收?)`);
		}
		if (chunk.ok === false) throw new Error(`dump 返回 ok:false at offset ${offset}: ${JSON.stringify(chunk).slice(0, 200)}`);
		if (Array.isArray(chunk.rows)) all.push(...chunk.rows);
		if (chunk.hasMore === false || !chunk.hasMore) break;
		offset += chunk.returned || limit;
		if (!chunk.returned) break; // 防死循环
	}
	return all;
}

function mapRow(r) {
	return {
		postedAtLabel: str(r.postedAtLabel),
		postedAt: str(r.postedAt),
		url: str(r.url),
		content: str(r.content),
		authorName: str(r.authorName),
		authorHandle: str(r.authorHandle),
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const required = ["keyword", "timePhrase", "dateRange", "queryUrl", "benchmark", "output"];
	for (const k of required) if (!args[k] || args[k] === "true") throw new Error(`missing --${k}`);
	if (!/^(past-24h|past-week|past-month)$/.test(args.dateRange)) throw new Error(`bad --dateRange: ${args.dateRange}`);

	// 先 parse benchmark(快失败,避免无谓 CDP 连接)
	let benchmark;
	try { benchmark = JSON.parse(args.benchmark); }
	catch { throw new Error(`--benchmark 不是合法 JSON: ${args.benchmark.slice(0, 200)}`); }

	const cdp = createCdpClient();
	// 复用现有 LinkedIn tab(反爬单 tab 规则)。worker 第1步已 navigate 过。
	const tab = await cdp.findTab({ urlContains: "linkedin.com/search/results/content" });
	const rows = await collectAllRows(tab, cdp.evaluate.bind(cdp));

	const envelope = {
		platform: "LinkedIn",
		keyword: str(args.keyword),
		retrievedAt: new Date().toISOString(),
		queryUrl: str(args.queryUrl),
		timeWindow: { timePhrase: str(args.timePhrase), dateRange: str(args.dateRange) },
		benchmark: {
			stopReason: str(benchmark.stoppedReason || benchmark.stopReason),
			scrollRounds: num0(benchmark.actualRounds ?? benchmark.scrollRounds),
			totalDiscovered: num0(benchmark.totalDiscovered),
			buttonClicks: num0(benchmark.buttonClicks),
			inWindow: rows.length,
		},
		results: rows.map(mapRow),
	};

	const output = str(args.output);
	mkdirSync(dirname(output), { recursive: true });
	const text = JSON.stringify(envelope, null, 2); // 序列化器保证合法 JSON
	writeFileSync(output, text, "utf8");

	// round-trip 自检:写完立刻读回 parse,失败则抛(verify 前拦截非法 JSON)
	try { JSON.parse(readFileSync(output, "utf8")); }
	catch (e) { throw new Error(`round-trip JSON 校验失败(刚写的文件不合法): ${e.message}`); }

	console.log(`linkedin collect-and-write: ${rows.length} rows, ${text.length} bytes → ${output}`);
}

main().catch((e) => { console.error("collect-and-write FAILED:", e.message); process.exit(1); });
