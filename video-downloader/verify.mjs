import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const outputDir = process.env.TASK_OUTPUT_DIR;
const failures = [];

function fail(assertion, expected, actual, hint) {
	failures.push({ assertion, expected, actual, ...(hint ? { hint } : {}) });
}

function readJson(name) {
	const filePath = join(outputDir, name);
	if (!existsSync(filePath)) {
		fail(`${name} exists`, "file exists", "missing", filePath);
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		fail(`${name} is valid JSON`, "parseable JSON", error.message);
		return undefined;
	}
}

if (!outputDir || !existsSync(outputDir)) {
	fail("TASK_OUTPUT_DIR exists", "existing output directory", outputDir || "missing");
} else {
	const metadata = readJson("metadata.json");
	const summary = readJson("download-summary.json");
	const entries = await readdir(outputDir);
	const videos = entries.filter((name) => name.toLowerCase().endsWith(".mp4"));
	const subtitles = entries.filter((name) => /\.(vtt|srt|ass)$/i.test(name));
	const summaryVideos = Array.isArray(summary?.videoFiles) ? summary.videoFiles : [];
	const videosToCheck = summaryVideos.length > 0 ? summaryVideos.map((file) => String(file)) : videos;

	if (videosToCheck.length === 0) {
		fail("mp4 video exists", "at least one .mp4 file", "none");
	}
	for (const video of videosToCheck) {
		const videoPath = join(outputDir, video);
		if (!existsSync(videoPath)) {
			fail(`download-summary.videoFiles ${video}`, "existing file", "missing");
			continue;
		}
		// ponytail: 完整性判据改为 ffprobe duration>0 + 有视频流 + yt-dlp 退出码 0(脚本层 throw 保证)。
		// 去掉 "> 1 MiB" 绝对阈值:它会误杀短视频/shorts/低分辨率视频(合法下载可能远小于 1MB)。
		// 第一性:完整性看元数据一致性,不看绝对字节数。
		try {
			const probe = execFileSync("ffprobe", [
				"-v", "quiet",
				"-print_format", "json",
				"-show_format",
				"-show_streams",
				videoPath,
			], { encoding: "utf8" });
			const info = JSON.parse(probe);
			if (!Array.isArray(info.streams) || info.streams.length === 0) {
				fail(`${video} has media streams`, "one or more streams", "0 streams");
			}
			const duration = Number(info.format?.duration);
			if (!Number.isFinite(duration) || duration <= 0) {
				fail(`${video} duration`, "duration > 0", String(info.format?.duration));
			}
		} catch (error) {
			fail(`${video} ffprobe`, "ffprobe parses video", error.message);
		}
	}

	// ponytail: 字幕"该不该下"的判断收敛到脚本算出的 summary.subtitleSelection,不在 verify 重算。
	// 脚本已根据 metadata + 用户意图决定 langs(空=无字幕可下/不需要;非空=该下)。
	// verify 只验证"脚本说该下 → 真有字幕文件";避免 verify 和脚本两套判断逻辑漂移。
	const subSelection = summary?.subtitleSelection;
	if (subSelection && subSelection.langs && subtitles.length === 0) {
		fail("subtitles downloaded when plan requires", subSelection.langs, "no subtitle files");
	}
	if (summary) {
		if (!summary.extractor) fail("download-summary.extractor", "non-empty extractor", JSON.stringify(summary.extractor));
		if (!Array.isArray(summary.videoFiles) || summary.videoFiles.length === 0) {
			fail("download-summary.videoFiles", "non-empty array", JSON.stringify(summary.videoFiles));
		}
		if (subSelection && subSelection.langs && (!Array.isArray(summary.subtitleFiles) || summary.subtitleFiles.length === 0)) {
			fail("download-summary.subtitleFiles", "non-empty array when subtitles required", JSON.stringify(summary.subtitleFiles));
		}
	}
}

if (failures.length > 0) {
	console.log(JSON.stringify(failures, null, 2));
	process.exit(1);
}
console.log("PASS");
process.exit(0);
