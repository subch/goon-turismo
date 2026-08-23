# Goon Turismo

Tracks our crew's participation in Gran Turismo 7 Time Trials — both the official
ones tracked by [dg-edge.com](https://www.dg-edge.com/events/time-trials) and our
own custom group events — plus team championship standings and a tune/parts-list
archive. Hosted as a static site on GitHub Pages at **goon-turismo.com**.

## What it does

- **Player stats and events** are synced from two GitHub Actions workflows, both every 6 hours
  (offset from each other so they don't usually race): `scrape-dg-edge.yml` scrapes
  [dg-edge.com](https://www.dg-edge.com) for the live/upcoming events listing (dg-edge no longer
  shows a per-event leaderboard, so it doesn't contribute individual results, just event metadata);
  `scrape-gridstats-web.yml` pulls event/result history from [GT-GridStats](https://gt-gridstats.com)'
  public player pages. Both went from once-nightly to every-6-hours on 2026-08-23 — a player who set
  a time right after a sync used to wait up to 24h for the next one to pick it up. GT-GridStats also
  has a real token-based API with richer per-player stats (DR/SR + more), but that account is capped
  at 5 requests/day (a full sync costs 2), so *that specific step* still only runs once/day (a fixed
  UTC hour inside `scrape-gridstats-web.yml`, not the whole workflow) — the free event/result scraping
  around it isn't quota-limited and runs every firing. GT-GridStats doesn't publish an event-listing
  or per-event-leaderboard API, so event/result syncing goes through its public pages regardless.
- **Data integrity is checked after every sync.** `scripts/verify-data-integrity.mjs`
  (`npm run verify:data`) runs as the last step of both scrape workflows, after data is already
  committed and pushed — so a problem it finds never blocks or loses a scrape, it just fails that
  Actions run so it's visible right away. Checks: no duplicate events (reuses the exact matching
  logic the scrapers use, so it can't be stricter or looser than what actually created the data),
  no result pointing at a nonexistent event, no event pointing at a nonexistent season. Added after
  two separate duplicate-event bugs each went unnoticed for days despite the scrapers running
  successfully every night — this catches that whole category of problem same-day instead.
- **Time Trial results** — official and custom — feed points-based standings, grouped by season.
  The standings page defaults to the current season with a dropdown to browse any past season,
  each showing the season's overall standings plus a full breakdown of every Time Trial run that
  season. Per-event scoring is percent-off-pace: the fastest group time in an event scores 100,
  and every 1% off that pace costs 10 points. Season totals drop each player's worst-scoring
  events (an event you skipped entirely counts as a 0 for this purpose too, so skipping a couple
  events a season is effectively free) — up to 2, scaling in with how many events the season has
  had so far (`floor(seasonEventCount / 3)`, capped at 2) so a brand new season's first few events
  don't get mostly discarded. Both rules match the crew's original scoring spreadsheet's formulas
  (`=IF(...,100-((time/MIN(...)-1)*1000))` per event, `=SUM(...)-SMALL(...,1)-SMALL(...,2)` for the
  season total), confirmed against real formulas in the crew's exported workbook and validated
  against 1200+ historical results.
- **11 past seasons (2023 through Spring 2026)** are backfilled from the crew's original scoring
  spreadsheet via `scripts/import-historical-seasons.mjs` — safe to re-run if a season needs
  re-importing.
- **Gap-filling from GT-GridStats.** The spreadsheet wasn't tracked consistently every season. The
  GT-GridStats sync (`scrape-gridstats-web.mjs`) scans each player's *full* event history —
  paginating through every page, not just the first — against every past season, not just the
  current one, and adds any (player, track, ~date) result that isn't already recorded from any
  source, filling real gaps without touching or duplicating anything the spreadsheet already has.
- **No duplicate events.** dg-edge and GT-GridStats independently discover the same real-world
  Time Trials under completely different ids and track-name spellings. Every scrape matches new
  events against everything already on file (by season + fuzzy track name + date, shared logic in
  `scripts/lib/seasons.mjs`) before deciding whether to attach to an existing event or create a new
  one — so the same real Time Trial only ever shows up once, with data merged in from whichever
  sources found it. Source labels (dg-edge/GT-GridStats/historical) aren't shown in the UI; they
  only matter internally for merge priority.
- **The current season's still-running Time Trials** are called out as "Active" and shown up top
  with a track photo, ahead of the season's other (finished) events for that same season.
- **Each Time Trial's track and car link out to the [GT7 wiki](https://gran-turismo.fandom.com/wiki/Gran_Turismo_7)**
  (best-effort, guessed from the name on file — roughly half resolve to a real page in practice,
  since track/car names aren't spelled consistently across the site's different data sources and
  the wiki's own page titles don't always match either. Generic car-class entries like "Gr.3" are
  skipped entirely rather than linked, since those never have their own page), and events show a
  track photo when GT-GridStats has one under a matching name (same best-effort caveat, more
  reliably for GT-GridStats-sourced events than spreadsheet-derived ones with shorter/different
  names).
- **Events, tune submissions, and championship round updates** all come in through GitHub Issue
  Forms, processed automatically into the site's data.
- **Team championship standings** track round-by-round points across the season, with roster names
  linked to player pages where the PSN is known.
- **Dates always display as "D MMM YYYY"** (e.g. "23 Jul 2026") regardless of which of the two raw
  formats they're stored in (ISO for historical/spreadsheet-imported events, "D Month YYYY" for
  scraped ones).
- **Tune archive** for GT7 car setups/parts lists, browsable by car.
- The site rebuilds and redeploys automatically on every data update.

All data lives in `data/` as version-controlled JSON; `scripts/` holds the sync/processing jobs
and `.github/workflows/` schedules and wires them together.

## Future plans

- Car thumbnails: GT-GridStats' own car images are keyed by opaque numeric IDs with no
  name-to-ID mapping available, so only track photos are shown for now. Real car thumbnails would
  need scraping each unique car's GT7 wiki infobox image instead.
- If GT-GridStats ever documents an event-listing or per-event-leaderboard API endpoint, swap the
  public-page event/result scraping in `scrape-gridstats-web.mjs` for that instead.

## Local development

```bash
npm install
npm run dev
```

Run the scrapers locally (writes into `data/`):

```bash
npm run scrape:dg-edge
npm run scrape:gridstats-web        # GT-GridStats public pages: events, results, fallback stats
GT_GRIDSTATS_TOKEN=xxx npm run scrape:gridstats   # real API: richer DR/SR/stats (5 req/day quota -- don't run this repeatedly)
npm run verify:data                 # data integrity check (no duplicates, no dangling references)
```
