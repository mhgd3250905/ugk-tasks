# diabetes-news-report-packager

Merge collector JSON artifacts, clean/dedupe/sort them, and write one report pack JSON for downstream translation and rendering.

## Input

Read `TASK_INPUT` JSON:

- `inputPaths`: required array of collector JSON files or directories.
- `maxItems`: optional, default 300, hard max 500.
- `title`: optional report title to carry downstream.

## Steps

Run:

```bash
node "$TASK_DIR/scripts/pack.mjs"
```

Write exactly one artifact:

- `diabetes_news_report_pack.json`

Do not translate, render HTML, fetch the web, call CDP, or mutate input JSON files.
