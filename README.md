# Goon Turismo

Tracks our crew's participation in Gran Turismo 7 Time Trials — both the official
ones tracked by [dg-edge.com](https://www.dg-edge.com/events/time-trials) and our
own custom group events — plus team championship standings and a tune/parts-list
archive. Hosted as a static site on GitHub Pages at **goon-turismo.com**.

## What it does

- **Player stats** are synced nightly from [GT-GridStats](https://gt-gridstats.com) (DR/SR and
  event history) and from dg-edge.com (aggregate stats).
- **Time Trial results** — official and custom — feed a per-season points leaderboard.
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
- Backfill historical seasons from the old spreadsheets (only the current season is seeded so far).
- Replace the placeholder points system with the crew's real scoring rules.
- Finish confirming a couple of remaining PSNs in the championship roster.

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
