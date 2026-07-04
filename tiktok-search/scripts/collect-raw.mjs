// collect-raw.mjs — tiktok-search 的 raw 数据落地脚本。
// ponytail: 替代 worker 用 write tool 逐 token 写 _raw_rows.json(同款 LLM 逐 token 慢病)。
// node 直连 CDP 循环 evaluate dump-result.js 取全量 rows → writeFileSync。LLM 完全不碰 raw 内容。
//
// 用法(单行 bash,worker 调):
//   node "$TASK_DIR/scripts/collect-raw.mjs" --output "$TASK_OUTPUT_DIR/_raw_rows.json"

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

// ponytail: 剥掉头部注释行,避免 return //comment 的 ASI 陷阱
const DUMP_SCRIPT = readFileSync(new URL("./dump-result.js", import.meta.url), "utf8");
const DUMP_CLEAN = DUMP_SCRIPT.replace(/^\/\/.*$/gm, "").trim();

async function collectAllRows(tab, evaluate) {
	const all = [];
	let offset = 0;
	const limit = 100;
	let safety = 0;
	while (safety++ < 100) {
		const expr = `window.__tiktokDumpConfig = { offset: ${offset}, limit: ${limit} }; ${DUMP_CLEAN}`;
		const chunk = await evaluate(tab, expr, { timeoutMs: 30000 });
		if (chunk === undefined || chunk === null) {
			throw new Error(`dump evaluate 返回 ${String(chunk)}(collector 是否还在?)`);
		}
		if (chunk.ok === false) throw new Error(`dump ok:false at offset ${offset}: ${JSON.stringify(chunk).slice(0, 200)}`);
		if (Array.isArray(chunk.rows)) all.push(...chunk.rows);
		if (chunk.hasMore === false || !chunk.hasMore) break;
		offset += chunk.returned || limit;
		if (!chunk.returned) break;
	}
	return all;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.output || args.output === "true") throw new Error("missing --output");

	const cdp = createCdpClient();
	const tab = await cdp.findTab({ urlContains: "tiktok.com/search" });
	const rows = await collectAllRows(tab, cdp.evaluate.bind(cdp));

	const output = resolve(args.output);
	mkdirSync(dirname(output), { recursive: true });
	// _raw_rows.json 是 bare array(filter-lib selectRecentRelevantVideos 期望数组)
	const text = JSON.stringify(rows, null, 2);
	writeFileSync(output, text, "utf8");

	try { JSON.parse(readFileSync(output, "utf8")); }
	catch (e) { throw new Error(`round-trip JSON 校验失败: ${e.message}`); }

	console.log(`tiktok collect-raw: ${rows.length} rows, ${text.length} bytes → ${output}`);
}

main().catch((e) => { console.error("collect-raw FAILED:", e.message); process.exit(1); });
