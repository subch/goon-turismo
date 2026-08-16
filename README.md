# Goon Turismo

Tracks our crew's participation in Gran Turismo 7 Time Trials — both the official
ones tracked by [dg-edge.com](https://www.dg-edge.com/events/time-trials) and our
own custom group events — plus team championship standings and a tune/parts-list
archive. Hosted as a static site on GitHub Pages at **goon-turismo.com**.

## What it does

- **Player stats** are synced nightly from [GT-GridStats](https://gt-gridstats.com) (DR/SR and
  event history) and from dg-edge.com (aggregate stats).
- **Time Trial results** — official and custom — feed points-based standings, grouped by season.
  The standings page defaults to the current season with a dropdown to browse any past season,
  each showing the season's overall standings plus a full breakdown of every Time Trial run that
  season. Per-event scoring is percent-off-pace: the fastest group time in an event scores 100,
  and every 1% off that pace costs 10 points. Season totals drop each player's 2 lowest-scoring
  events (an event you skipped entirely counts as a 0 for this purpose too, so skipping 1-2 events
  a season is effectively free). Both rules match the crew's original scoring spreadsheet's
  formulas (`=IF(...,100-((time/MIN(...)-1)*1000))` per event,
  `=SUM(...)-SMALL(...,1)-SMALL(...,2)` for the season total), confirmed against real formulas in
  the crew's exported workbook and validated against 1200+ historical results.
- **11 past seasons (2023 through Spring 2026)** are backfilled from the crew's original scoring
  spreadsheet via `scripts/import-historical-seasons.mjs` — safe to re-run if a season needs
  re-importing.
- **Gap-filling from GT-GridStats.** The spreadsheet wasn't tracked consistently every season
  (Summer/Spring in particular). The nightly GT-GridStats sync (`scrape-gridstats-web.mjs`) now
  also scans each player's *full* event history against every past season, not just the current
  one, and adds any (player, track, ~date) result that isn't already recorded from any source as a
  supplemental `gridstats`-sourced event — filling real gaps without touching or duplicating
  anything the spreadsheet already has.
- **Each Time Trial's track and car link out to the [GT7 wiki](https://gran-turismo.fandom.com/wiki/Gran_Turismo_7)**
  (best-effort — generic class-code entries like "Gr.3" from older spreadsheet rows don't always
  resolve to a real page).
- **Events, tune submissions, and championship round updates** all come in through GitHub Issue
  Forms, processed automatically into the site's data.
- **Team championship standings** track round-by-round points across the season.
- **Tune archive** for GT7 car setups/parts lists, browsable by car.
- The site rebuilds and redeploys automatically on every data update.

All data lives in `data/` as version-controlled JSON; `scripts/` holds the sync/processing jobs
and `.github/workflows/` schedules and wires them together.

## Future plans

- Swap the interim GT-GridStats web scraper for the official token-based API once a
  `GT_GRIDSTATS_TOKEN` is obtained from the maintainer.
- Finish confirming a couple of remaining PSNs in the championship roster ("Fairfax" and
  "Crockhaed"/craigrackhaed).

## Local development

```bash
npm install
npm run dev
```

Run the scrapers locally (writes into `data/`):

```bash
npm run scrape:dg-edge
npm run scrape:gridstats-web        # interim GT-GridStats scraper, no token needed
GT_GRIDSTATS_TOKEN=xxx npm run scrape:gridstats   # once a token is available
```
