# diabetes-news-report-renderer

Render one diabetes news report pack into the fixed HTML report template.

## Input

Read `TASK_INPUT` JSON:

- `packPath`: required path to `diabetes_news_report_pack.json` or `diabetes_news_report_pack.zh-CN.json`.
- `targetLanguage`: optional. Defaults to pack `targetLanguage` or `original`. `zh-CN` requires translated fields in the pack.
- `title`: optional report title override.

## Steps

Run:

```bash
node "$TASK_DIR/scripts/render.mjs"
```

Write exactly one artifact:

- `diabetes_news_report.html`

The renderer does not merge raw collector JSON, translate text, fetch the web, call CDP, or mutate input files.
