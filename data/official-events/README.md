# Official events

One JSON file per official Time Trial, plus `index.json` listing every event id. Written
automatically by three different sources, distinguished by the `source` field — do not hand-edit
a `dg-edge`/`gridstats`/`historical` file unless you're patching bad data, since the owning
script will overwrite the fields it manages on its next run:

- **`source: "dg-edge"`** — `scripts/scrape-dg-edge.mjs`, from dg-edge.com's events listing.
  Every field including `car`/`classCode` can legitimately be `null` (some events are restricted
  to an eligible car *class* rather than one specific car).
- **`source: "gridstats"`** — `scripts/scrape-gridstats-web.mjs`, from each tracked player's
  GT-GridStats event history. Covers the current season (refreshed every run) and fills gaps in
  past seasons the spreadsheet import missed (only added once, never overwritten after).
- **`source: "historical"`** — `scripts/import-historical-seasons.mjs`, backfilled once from the
  crew's original scoring spreadsheet. Re-running that script fully regenerates every historical
  event/result, so it's safe to re-run if a season needs fixing.

Every event has a `seasonId` (matches an id in `data/seasons.json`) — this is what the standings
page's season grouping and dropdown are built from.

Shape:

```json
{
  "id": "2026-08-lago-maggiore-mr2",
  "source": "dg-edge",
  "seasonId": "summer-2026",
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
