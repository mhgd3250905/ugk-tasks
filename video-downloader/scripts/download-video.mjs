import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeVideoUrl(rawUrl) {
	let url;
	try {
		url = new URL(String(rawUrl || "").trim());
	} catch {
		throw new Error("input.url must be a valid video URL");
	}
	if (!["http:", "https:"].includes(url.protocol)) {
		throw new Error("input.url must be an http or https video URL");
	}
	return url.href;
}

/**
 * 默认分辨率档位链(优先级从高到低)。未指定 maxHeight 时按此顺序找第一个可用档位。
 * ponytail: 固定档位而非"取最大",保证可预测(避免选到 8K/非标准怪分辨率)。
 */
const RESOLUTION_LADDER = [1080, 720, 480, 360, 240, 144];

/**
 * 从 yt-dlp metadata.formats 筛视频流,返回 {width,height} 尺寸集合。
 * 只看有 vcodec(非空且非 'none')的流,排除纯音频流和 storyboard。
 */
function availableVideoSizes(metadata) {
	const formats = Array.isArray(metadata?.formats) ? metadata.formats : [];
	const sizes = [];
	for (const f of formats) {
		const vcodec = String(f?.vcodec || "").toLowerCase();
		if (!vcodec || vcodec === "none") continue;
		const w = Number(f?.width);
		const h = Number(f?.height);
		if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) continue;
		sizes.push({ width: Math.floor(w), height: Math.floor(h) });
	}
	return sizes;
}

/**
 * 分辨率选择决策(纯函数,可单测)。
 *
 * 语义:
 *   - maxHeight 指定(有限正数): 选 <= maxHeight 内最大的高度(不超)。
 *   - maxHeight 未指定(undefined/NaN/<=0): 走固定档位链 1080→720→...→144,
 *     按链顺序找第一个"有可用格式落在该档位区间"的档位。区间匹配:高度 H 属于档位 R
 *     当且仅当 H<=R 且 H>下一档位(最小档位 144 之下也算命中 144)。例:H=1058 → 1080 档。
 *     这样非标准高度(1058/706/352/142 等 1080p/720p 变体)能正确映射,不必精确相等。
 *
 * 返回 { target: number|undefined, source: string, specified: boolean, available: number[] }
 *   - target undefined = 算不出来(空 formats),调用方应回退到 bv*+ba/b。
 *   - source: "specified-cap" | "ladder-match" | "fallback-max" | "none"
 *
 * ponytail: 决策逻辑集中在这一处,main() 拿 target 再 buildFormatSelector。
 * 不把选择逻辑塞进 yt-dlp format string 黑魔法,保持可测可读。
 */
export function selectTargetHeight(metadata, maxHeight, isVertical = false) {
	const specified = Number.isFinite(Number(maxHeight)) && Number(maxHeight) > 0;
	const sizes = availableVideoSizes(metadata);
	const dimKey = isVertical ? "width" : "height";
	const availableDims = [...new Set(sizes.map((s) => s[dimKey]))].sort((a, b) => a - b);

	if (availableDims.length === 0) {
		return { target: undefined, source: "none", specified, available: [] };
	}

	// 指定:选 <= N 内最大(不超)
	if (specified) {
		const cap = Math.floor(Number(maxHeight));
		const within = availableDims.filter((d) => d <= cap).sort((a, b) => b - a);
		if (within.length > 0) {
			return { target: within[0], source: "specified-cap", specified: true, available: availableDims };
		}
		// 指定了但没有任何 <= N 的(例如指定 240 但最低 360)→ 取最小(最接近不超)
		// ponytail: 用户明确要"不超",但物理上没有满足的,取最小比取最大更守约。
		return { target: availableDims[0], source: "specified-cap", specified: true, available: availableDims };
	}

	// 未指定:固定档位链,区间匹配(非标准高度如 1058 归入 1080 档)。
	// 档位 R 的区间是 (nextRung, R],nextRung 是下一档;最小档位之下也算命中最小档。
	for (let i = 0; i < RESOLUTION_LADDER.length; i += 1) {
		const rung = RESOLUTION_LADDER[i];
		const lowerBound = i + 1 < RESOLUTION_LADDER.length ? RESOLUTION_LADDER[i + 1] : 0;
		// 有任一可用高度落在 (lowerBound, rung] → 命中该档;target 取该区间内最大可用高度
		const inRange = availableDims.filter((d) => d > lowerBound && d <= rung);
		if (inRange.length > 0) {
			const target = Math.max(...inRange);
			return { target, source: "ladder-match", specified: false, available: availableDims };
		}
	}
	// 档位都凑不上(所有可用高度 > 1080,如 4K/8K):取可用最大
	return { target: availableDims[availableDims.length - 1], source: "fallback-max", specified: false, available: availableDims };
}

/**
 * Build format selector for yt-dlp given a chosen target height.
 *
 * For vertical videos (taller than wide), the stored frame height is the longer
 * dimension (e.g. 360p vertical → 360×640). Using `height<=480` on vertical
 * videos would only allow 240p. For vertical we filter on width (shorter dim).
 *
 * target undefined → return generic best fallback (no height constraint).
 */
export function buildFormatSelector(targetHeight, isVertical = false) {
	const val = Number(targetHeight);
	if (!Number.isFinite(val) || val <= 0) return "bv*+ba/b";
	const dim = Math.floor(val);
	if (isVertical) {
		// 竖屏:存储 height 是长边(=dim*2 量级),物理短边是 width。
		// 用 width<=dim 限短边;height<=dim*2 防止误选超长边。
		return `bv[width<=${dim}][height<=${dim * 2}]+ba/b[width<=${dim}]/bv[width<=${dim}]+ba/bv*+ba/b`;
	}
	return `bv*[height<=${dim}]+ba/b[height<=${dim}]/bv*+ba/b`;
}

function normalizeCookiesFromBrowser(value = "none") {
	const browser = String(value || "none").toLowerCase();
	if (browser === "none" || browser === "chrome") return browser;
	throw new Error("cookiesFromBrowser must be none or chrome");
}

function browserCookieArgs(input = {}) {
	const browser = normalizeCookiesFromBrowser(input.cookiesFromBrowser);
	return browser === "chrome" ? ["--cookies-from-browser", "chrome"] : [];
}

export async function findSubtitleFiles(outputDir) {
	const entries = await readdir(outputDir).catch(() => []);
	return entries.filter((name) => /\.(vtt|srt|ass)$/i.test(name)).sort();
}

async function findVideoFiles(outputDir) {
	const entries = await readdir(outputDir).catch(() => []);
	return entries.filter((name) => /\.mp4$/i.test(name)).sort();
}

/**
 * 字幕选择决策(纯函数,可单测)。
 *
 * 语义:
 *   - subLangs 指定(非空字符串): 严格用指定语种,含自动字幕(用户显式要的,给全)。
 *   - subLangs 未指定: 优先人工字幕(metadata.subtitles)非空 → 下其全部语种(量可控,
 *     通常 1-3 种,规避 YouTube 全量自动字幕触发 429)。只有 subtitles 空才回退
 *     automatic_captions,且按 en+zh 过滤(避免几百种自动字幕)。两者皆空 → 不下。
 *
 * 返回 { langs: string, includeAuto: boolean, source: string, specified: boolean, availableSubs: string[], availableAuto: string[] }
 *   - langs 传给 yt-dlp --sub-langs;includeAuto 决定是否加 --write-auto-subs。
 *   - langs 为空字符串 = 不下字幕(调用方应跳过 --write-subs)。
 *
 * ponytail: 决策集中,verify 只读 summary.subtitleSelection 不重算,避免两套逻辑漂移。
 */
export function resolveSubtitlePlan(metadata, subLangs) {
	const specified = typeof subLangs === "string" && subLangs.trim().length > 0;
	const manualSubs = metadata?.subtitles && typeof metadata.subtitles === "object" ? Object.keys(metadata.subtitles) : [];
	const autoSubs = metadata?.automatic_captions && typeof metadata.automatic_captions === "object" ? Object.keys(metadata.automatic_captions) : [];
	// 视频主语言(yt-dlp metadata.language,平台标注,如 "ru"/"pt-PT")。取 base 做匹配。
	const videoLangRaw = typeof metadata?.language === "string" ? metadata.language.trim() : "";
	const videoLangBase = videoLangRaw.split("-")[0].split(".")[0].toLowerCase();
	const hasVideoLang = videoLangBase.length > 0;

	if (specified) {
		return { langs: subLangs.trim(), includeAuto: true, source: "specified", specified: true, availableSubs: manualSubs, availableAuto: autoSubs, videoLanguage: videoLangRaw || null };
	}

	// 未指定:优先人工字幕
	if (manualSubs.length > 0) {
		return { langs: manualSubs.join(","), includeAuto: false, source: "manual", specified: false, availableSubs: manualSubs, availableAuto: autoSubs, videoLanguage: videoLangRaw || null };
	}

	// 无人工字幕:优先下「视频主语言」的自动字幕(最贴合原声,质量通常最高)。
	// base 匹配会顺带命中 ru-orig / zh-Hans 这类同语言变体,反而更全。
	if (hasVideoLang) {
		const mainLangSubs = autoSubs.filter((lang) => {
			const base = String(lang).split("-")[0].split(".")[0].toLowerCase();
			return base === videoLangBase;
		});
		if (mainLangSubs.length > 0) {
			return { langs: mainLangSubs.join(","), includeAuto: true, source: "auto-main-lang", specified: false, availableSubs: manualSubs, availableAuto: autoSubs, videoLanguage: videoLangRaw };
		}
	}

	// 主语言没有自动字幕:回退 en+zh
	const preferred = autoSubs.filter((lang) => {
		const base = String(lang).split("-")[0].split(".")[0].toLowerCase();
		return base === "en" || base === "zh";
	});
	if (preferred.length > 0) {
		return { langs: preferred.join(","), includeAuto: true, source: "auto-en-zh", specified: false, availableSubs: manualSubs, availableAuto: autoSubs, videoLanguage: videoLangRaw || null };
	}

	// 两者皆空:不下
	return { langs: "", includeAuto: false, source: "none", specified: false, availableSubs: manualSubs, availableAuto: autoSubs, videoLanguage: videoLangRaw || null };
}

async function run(command, args, options = {}) {
	const child = spawn(command, args, { windowsHide: true });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		if (options.streamStdout) process.stdout.write(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
		if (options.streamStderr) process.stderr.write(chunk);
	});
	const exitCode = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	if (exitCode !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with exit ${exitCode}:\n${stderr || stdout}`);
	}
	return { stdout, stderr };
}

async function requireCommand(command, args) {
	await run(command, args);
}

export function buildMetadataArgs(url, input = {}) {
	return [
		...browserCookieArgs(input),
		"--skip-download",
		"--dump-json",
		"--no-playlist",
		url,
	];
}

export function buildDownloadArgs(input, options = {}) {
	// ponytail: format/subLangs 不再从 input 直接取,改由 main() 先算出 targetHeight/subtitlePlan 传入。
	// 这样选择逻辑在纯函数里,buildDownloadArgs 只负责拼 yt-dlp 参数。
	const targetHeight = options.targetHeight;
	const isVertical = Boolean(options.isVertical);
	const subtitlePlan = options.subtitlePlan || { langs: "", includeAuto: false };
	const hasSubs = subtitlePlan.langs.length > 0;
	const args = [
		...browserCookieArgs(input),
		"--newline",
		"--concurrent-fragments", "8",
		"--no-playlist",
		"--ignore-errors",
		"--paths", input.outputDir,
		"--output", "%(extractor_key)s-%(id)s.%(ext)s",
		"--merge-output-format", "mp4",
		"--format", buildFormatSelector(targetHeight, isVertical),
	];
	if (hasSubs) {
		args.push(
			"--write-subs",
			...(subtitlePlan.includeAuto ? ["--write-auto-subs"] : []),
			"--sub-langs", subtitlePlan.langs,
			"--sub-format", "vtt",
		);
	}
	args.push(input.url);
	return args;
}

export function parseCliArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
		values[key] = argv[index + 1];
		index += 1;
	}
	return {
		...(values.url ? { url: normalizeVideoUrl(values.url) } : {}),
		...(values.outputDir ? { outputDir: values.outputDir } : {}),
		...(values.maxHeight ? { maxHeight: Number(values.maxHeight) } : {}),
		...(values.subLangs ? { subLangs: values.subLangs } : {}),
		...(values.cookiesFromBrowser ? { cookiesFromBrowser: normalizeCookiesFromBrowser(values.cookiesFromBrowser) } : {}),
	};
}

export function parseInput(argv = process.argv.slice(2), env = process.env) {
	const cli = parseCliArgs(argv);
	const input = JSON.parse(env.TASK_INPUT || "{}");
	const outputDir = cli.outputDir || env.TASK_OUTPUT_DIR;
	if (!outputDir) throw new Error("TASK_OUTPUT_DIR is required");
	// ponytail: maxHeight/subLangs 不补默认值。是否指定由调用方按字段是否存在判断。
	// 这样脚本能区分"用户显式要 480"和"系统补的 480",走不同的选择策略。
	const merged = { ...input, ...cli };
	const result = {
		url: normalizeVideoUrl(merged.url),
		cookiesFromBrowser: normalizeCookiesFromBrowser(merged.cookiesFromBrowser || "none"),
		outputDir,
	};
	// 只在字段存在且有效(正数)时带上,让 selectTargetHeight/resolveSubtitlePlan 判"是否指定"。
	// ponytail: 此处就把 0/负数/NaN 挡掉,不依赖下游 selectTargetHeight 二次校验 —— 防御深度,字段语义在入口收敛。
	const maxH = Number(merged.maxHeight);
	if (merged.maxHeight !== undefined && merged.maxHeight !== "" && Number.isFinite(maxH) && maxH > 0) {
		result.maxHeight = Math.floor(maxH);
	}
	if (typeof merged.subLangs === "string" && merged.subLangs.trim()) {
		result.subLangs = merged.subLangs.trim();
	}
	return result;
}

async function main() {
	const input = parseInput();
	await mkdir(input.outputDir, { recursive: true });
	await requireCommand("yt-dlp", ["--version"]);
	await requireCommand("ffmpeg", ["-version"]);
	await requireCommand("ffprobe", ["-version"]);
	// ponytail: deno 是 yt-dlp 新版的 JS 运行时,下 YouTube 自动字幕必需。
	// 缺了会 "No supported JavaScript runtime" + 自动字幕下载失败(429/拿不到)。
	// 这是第二道防线——主防线在 contract.requiredBinaries(框架 preflight 提前拦)。
	await requireCommand("deno", ["--version"]);

	const metadataResult = await run("yt-dlp", buildMetadataArgs(input.url, input), { streamStderr: true });
	const metadata = JSON.parse(metadataResult.stdout);
	await writeFile(path.join(input.outputDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");

	// 决策阶段:依据实际 metadata 做分辨率 + 字幕选择(确定性,纯函数)
	const isVertical = (metadata.width || 0) < (metadata.height || 0);
	const heightDecision = selectTargetHeight(metadata, input.maxHeight, isVertical);
	const subtitlePlan = resolveSubtitlePlan(metadata, input.subLangs);

	console.log(`Video orientation: ${isVertical ? 'vertical (portrait)' : 'horizontal (landscape)'}, resolution: ${metadata.width}x${metadata.height}`);
	console.log(`Resolution decision: specified=${heightDecision.specified}, target=${heightDecision.target ?? 'N/A'}, source=${heightDecision.source}, available=[${heightDecision.available.join(',')}]`);
	console.log(`Subtitle decision: specified=${subtitlePlan.specified}, langs="${subtitlePlan.langs}", includeAuto=${subtitlePlan.includeAuto}, source=${subtitlePlan.source}`);

	await run("yt-dlp", buildDownloadArgs(input, { targetHeight: heightDecision.target, isVertical, subtitlePlan }), { streamStdout: true, streamStderr: true });

	const videoFiles = await findVideoFiles(input.outputDir);
	const subtitleFiles = await findSubtitleFiles(input.outputDir);
	if (videoFiles.length === 0) throw new Error("yt-dlp finished but no mp4 file was found");

	const summary = {
		url: input.url,
		extractor: metadata.extractor_key,
		id: metadata.id,
		displayId: metadata.display_id,
		title: metadata.title,
		duration: metadata.duration,
		format: buildFormatSelector(heightDecision.target, isVertical),
		isVertical,
		cookiesFromBrowser: input.cookiesFromBrowser,
		// ponytail: 把决策依据写进 summary,verify 据此判断"该不该有字幕",不再从 metadata+input 重算(避免两套逻辑漂移)。
		resolutionSelection: {
			specified: heightDecision.specified,
			maxHeight: input.maxHeight ?? null,
			target: heightDecision.target ?? null,
			source: heightDecision.source,
			available: heightDecision.available,
		},
		subtitleSelection: {
			specified: subtitlePlan.specified,
			videoLanguage: subtitlePlan.videoLanguage,
			subLangs: subtitlePlan.langs,
			includeAuto: subtitlePlan.includeAuto,
			source: subtitlePlan.source,
			availableSubs: subtitlePlan.availableSubs,
			availableAuto: subtitlePlan.availableAuto,
		},
		videoFiles,
		subtitleFiles,
	};
	await writeFile(path.join(input.outputDir, "download-summary.json"), JSON.stringify(summary, null, 2), "utf8");
	console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && existsSync(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
