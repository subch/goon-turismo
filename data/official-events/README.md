# Official events

One JSON file per official dg-edge.com-tracked Time Trial, written automatically by
`scripts/scrape-dg-edge.mjs`. Do not hand-edit these unless you're patching bad data —
the scraper will overwrite fields it owns on its next run.

Shape:

```json
{
  "id": "2026-08-lago-maggiore-mr2",
  "source": "dg-edge",
  "track": "Autodrome Lago Maggiore East End",
  "car": "Toyota MR2 GT-S '97",
  "classCode": "SH",
  "startDate": "2026-08-01",
  "endDate": "2026-08-29",
  "status": "live",
  "dgEdgeUrl": "https://www.dg-edge.com/events/time-trials/...",
  "lastScraped": "2026-08-16T00:00:00Z"
}
```
