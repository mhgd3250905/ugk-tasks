# medical-diabetes-news

Collect recent diabetes-related medical news metadata from RSS, sitemap, and simple HTTP sources, ranking diabetes medical-device items first.

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

- `medical_diabetes_news.json`

3. Keep the JSON audit fields:

- `task`
- `retrievedAt`
- `timeWindow`
- `sources`
- `sourceStatus`
- `summary`
- `results`

Result rows preserve source titles, dates, URLs, excerpts, source names, and `isDeviceRelated`. Do not use CDP. Do not fetch article pages. Do not output Markdown or HTML.
