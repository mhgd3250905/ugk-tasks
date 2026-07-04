// collect-raw.mjs — reddit-search 的 raw 数据落地脚本。
// ponytail: 替代 worker 用 write tool 逐 token 写 _raw.json(实测 ~4min,LLM 逐 token)。
// node 直连 CDP 循环 evaluate dump-result.js 取全量 posts → writeFileSync。LLM 完全不碰 raw 内容。
//
// 用法(单行 bash,worker 调):
//   node "$TASK_DIR/scripts/collect-raw.mjs" --output "$TASK_OUTPUT_DIR/_raw.json"
//
// 取数:循环 evaluate dump-result.js(offset += 100),读 window.__redditCollector.posts。
// 写盘:JSON.stringify(bare array) + writeFileSync + round-trip 自检。

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

// ponytail: 剥掉头部注释行,避免 return //comment 的 ASI 陷阱(同 collect-and-write 的教训)
const DUMP_SCRIPT = readFileSync(new URL("./dump-result.js", import.meta.url), "utf8");
const DUMP_CLEAN = DUMP_SCRIPT.replace(/^\/\/.*$/gm, "").trim();

async function collectAllPosts(tab, evaluate) {
	const all = [];
	let offset = 0;
	const limit = 100;
	let safety = 0;
	while (safety++ < 100) {
		// 分号分隔,不用 return 包裹(避免 return+注释 ASI 陷阱)
		const expr = `window.__redditDumpConfig = { offset: ${offset}, limit: ${limit} }; ${DUMP_CLEAN}`;
		const chunk = await evaluate(tab, expr, { timeoutMs: 30000 });
		if (chunk === undefined || chunk === null) {
			throw new Error(`dump evaluate 返回 ${String(chunk)}(collector 是否还在?tab 是否被回收?)`);
		}
		if (chunk.ok === false) throw new Error(`dump 返回 ok:false at offset ${offset}: ${JSON.stringify(chunk).slice(0, 200)}`);
		// reddit dump-result.js 的字段:index/permalink/title/subreddit/postedAt/author/scoreText/bodyText
		if (Array.isArray(chunk.rows) || Array.isArray(chunk.posts)) {
			all.push(...(chunk.rows || chunk.posts));
		}
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
	// 优先用 UGK_CDP_TAB_ID(cdp-client.mjs 已实现),fallback 按 reddit URL
	const tab = await cdp.findTab({ urlContains: "reddit.com/search" });
	const posts = await collectAllPosts(tab, cdp.evaluate.bind(cdp));

	const output = resolve(args.output);
	mkdirSync(dirname(output), { recursive: true });
	// _raw.json 是 bare array(filter-lib 期望数组输入)
	const text = JSON.stringify(posts, null, 2);
	writeFileSync(output, text, "utf8");

	// round-trip 自检
	try { JSON.parse(readFileSync(output, "utf8")); }
	catch (e) { throw new Error(`round-trip JSON 校验失败: ${e.message}`); }

	console.log(`reddit collect-raw: ${posts.length} posts, ${text.length} bytes → ${output}`);
}

main().catch((e) => { console.error("collect-raw FAILED:", e.message); process.exit(1); });
