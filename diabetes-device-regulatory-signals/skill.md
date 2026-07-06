# diabetes-device-regulatory-signals

Collect recent official diabetes medical-device regulatory, database, safety, and conference signals.

## Input

Read `TASK_INPUT` JSON:

- `timePhrase`: original time expression only.
- `days`: integer 1..30.
- `startIso`: inclusive UTC ISO datetime.
- `endIso`: exclusive UTC ISO datetime.
- `maxItems`: optional, default 100, hard max 300.
- `sourceFilter`: optional. Default `all`; allowed values are `openfda-510k`, `openfda-recall`, `openfda-enforcement`, `clinicaltrials`, `fda-cdrh`, `fda-device-safety`, `ada`, `attd`, and `easd`.

Do not read or emit `targetLanguage`. Human-readable localization is handled by `diabetes-news-report-renderer`.

## Steps

1. Run the taskbook script:

```bash
node "$TASK_DIR/scripts/collect.mjs"
```

Run this command directly. Do not inspect the script first, and do not rerun it after it has started; if it exits non-zero, report failure.

2. Write exactly one artifact under `TASK_OUTPUT_DIR`:

- `diabetes_device_regulatory_signals.json`

3. Keep result fields:

- `source`
- `signalType`
- `title`
- `date`
- `url`
- `company`
- `deviceOrProduct`
- `context`
- `isDiabetesDeviceRelated`
- `id`

Use official APIs or official listing pages only. Do not use CDP. Do not scrape article detail pages. Do not output Markdown or HTML. Preserve official URLs, IDs, dates, and titles. Phase 2.5 official/conference sources are FDA CDRH News and Updates, FDA Medical Device Safety, ADA Scientific Sessions, ATTD Global, and EASD Annual Meeting.
