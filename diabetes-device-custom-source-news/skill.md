# diabetes-device-custom-source-news

Collect recent diabetes medical-device news from Phase 3 custom sources and CDP-recovered blocked sources.

## Input

Read `TASK_INPUT` JSON:

- `timePhrase`: original time expression only.
- `days`: integer 1..30.
- `startIso`: inclusive UTC ISO datetime.
- `endIso`: exclusive UTC ISO datetime.
- `maxItems`: optional, default 100, hard max 300.

Do not read or emit `targetLanguage`. Human-readable localization is handled by `diabetes-news-report-renderer`.

## Steps

1. Run the taskbook script:

```bash
node "$TASK_DIR/scripts/collect.mjs"
```

Run this command directly. Do not inspect the script first, and do not rerun it after it has started; if it exits non-zero, report failure.

2. Write exactly one artifact under `TASK_OUTPUT_DIR`:

- `diabetes_device_custom_source_news.json`

3. Keep result fields:

- `source`
- `title`
- `publishedAt`
- `url`
- `feedExcerpt`
- `isDeviceRelated`
- `id`

Use listing/RSS metadata only. Do not scrape article detail pages. Do not output Markdown or HTML. The script uses a temp-directory run lock so the same task is not run concurrently. It uses sequential self-managed Chrome CDP sessions for Dexcom IR, Insulet IR, MassDevice, and best-effort MobiHealthNews because direct HTTP is blocked by Cloudflare. If a source fails, the script retries only that failed source once.
