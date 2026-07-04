// write-output.mjs — reddit-search 的最终产物组装脚本。
// ponytail: 替代 worker 用 write tool 逐 token 输出 JSON(慢 + JSON 易错)。
// 数据已在 `_filtered.json`(filter-lib selectPosts 产物),本脚本纯文件操作,不需 CDP。
// 读 _filtered.json → 丢 postId → 包 envelope(含 timeRange 派生)→ writeFileSync → round-trip 自检。
//
// 用法(单行 bash,worker 调):
//   node "$TASK_DIR/scripts/write-output.mjs" \
//     --keyword "<原始 keyword>" --timePhrase "<timePhrase>" --days <N> \
//     --queryUrl "<URL>" --benchmark '<benchmark JSON>' \
//     --filtered "$TASK_OUTPUT_DIR/_filtered.json" \
//     --output "$TASK_OUTPUT_DIR/reddit_search_results.json"

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mapDaysToTimeRange } from "./filter-lib.mjs";

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
// ponytail: null/undefined 显式判(避免 Number(null)===0 的 JS 坑)。数字字段缺失应 null,不是 0。
const num = (x) => (x === null || x === undefined || x === "" ? null : (Number.isFinite(Number(x)) ? Number(x) : null));
const num0 = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

function mapRow(r) {
	// _filtered.json row: {permalink, postId, subreddit, title, postedAt, author, score, numComments, selftext}
	// 输出:丢 postId,其余 1:1
	return {
		postedAt: str(r.postedAt),
		title: str(r.title),
		subreddit: str(r.subreddit),
		author: str(r.author),
		score: num(r.score),
		numComments: num(r.numComments),
		selftext: str(r.selftext),
		permalink: str(r.permalink),
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	for (const k of ["keyword", "timePhrase", "days", "queryUrl", "benchmark", "filtered", "output"]) {
		if (!args[k] || args[k] === "true") throw new Error(`missing --${k}`);
	}
	const days = Number(args.days);
	if (!Number.isFinite(days) || days <= 0) throw new Error(`bad --days: ${args.days}`);

	let benchmark;
	try { benchmark = JSON.parse(args.benchmark); }
	catch { throw new Error(`--benchmark 不是合法 JSON: ${args.benchmark.slice(0, 200)}`); }

	// ponytail: resolve 相对路径(基于 cwd)。worker 有时传裸 "_filtered.json",
	// 导致 ENOENT。resolve 让相对路径基于 worker 的 cwd 解析。
	const filteredPath = resolve(args.filtered);
	const raw = readFileSync(filteredPath, "utf8");
	let filtered;
	try { filtered = JSON.parse(raw); }
	catch (e) { throw new Error(`_filtered.json 不是合法 JSON: ${e.message}`); }
	if (!Array.isArray(filtered)) throw new Error(`_filtered.json 不是数组: ${typeof filtered}`);

	const envelope = {
		platform: "Reddit",
		keyword: str(args.keyword),
		retrievedAt: new Date().toISOString(),
		queryUrl: str(args.queryUrl),
		timeWindow: { timePhrase: str(args.timePhrase), days, timeRange: mapDaysToTimeRange(days) },
		benchmark: {
			stopReason: str(benchmark.stopReason || benchmark.stoppedReason),
			rounds: num0(benchmark.rounds),
			maxRounds: num0(benchmark.maxRounds),
			totalCollected: num0(benchmark.totalCollected ?? benchmark.totalPosts),
			filteredRows: filtered.length,
			totalRunMs: num0(benchmark.totalRunMs),
		},
		results: filtered.map(mapRow),
	};

	const output = str(args.output);
	mkdirSync(dirname(output), { recursive: true });
	const text = JSON.stringify(envelope, null, 2);
	writeFileSync(output, text, "utf8");

	try { JSON.parse(readFileSync(output, "utf8")); }
	catch (e) { throw new Error(`round-trip JSON 校验失败: ${e.message}`); }

	console.log(`reddit write-output: ${filtered.length} rows, ${text.length} bytes → ${output}`);
}

main().catch((e) => { console.error("write-output FAILED:", e.message); process.exit(1); });
