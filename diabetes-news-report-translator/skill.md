# diabetes-news-report-translator

Translate visible fields from one diabetes news report pack into Chinese. This task only translates the already-packed final report items, so large upstream collector JSON does not overload translation.

## Input

Read `TASK_INPUT` JSON:

- `packPath`: required path to `diabetes_news_report_pack.json`.
- `targetLanguage`: required, currently only `zh-CN`.

If the user does not provide an explicit local `packPath`, do not guess a path and do not output runtime JSON. The task must fail input extraction so the user can provide the pack file.

## Steps

1. Prepare the translation units:

```bash
node "$TASK_DIR/scripts/prepare.mjs"
```

2. Read `$TASK_OUTPUT_DIR/translation_units.json`.

3. Write `$TASK_OUTPUT_DIR/translations.zh-CN.json` with this exact shape:

```json
{
  "targetLanguage": "zh-CN",
  "translatedTitle": "中文报告标题",
  "items": [
    {
      "itemId": "item-example",
      "translatedTitle": "中文标题",
      "translatedSummary": "中文摘要"
    }
  ]
}
```

Rules:

- Translate `title` and `summary` so a Chinese-only reader can understand the report.
- Preserve URLs, dates, source names, company/product names, FDA, 510(k), NCT, and other official identifiers.
- Do not add medical advice or facts not present in the source text.
- If a source field is already Chinese, keep it Chinese and concise.
- If there are many items, translate in batches and print progress like `[translate] batch 1/4 items 1-50`.

4. Build the translated pack:

```bash
node "$TASK_DIR/scripts/build.mjs"
```

## Output

- `translation_units.json`
- `translations.zh-CN.json`
- `diabetes_news_report_pack.zh-CN.json`

Do not render HTML or Markdown.
