# Goon Turismo

Tracks our crew's participation in Gran Turismo 7 Time Trials -- the game's official ones, pulled from
[GT-GridStats](https://gt-gridstats.com), plus our own custom group events -- with points-based season
standings, team championship standings, a tune/parts-list archive, and a real-world racing results hub
at `/racing/`. Static Astro site served from the VPS at **goon-turismo.com** (GitHub Pages is the rollback).

## What it does

- **One data source, one sync.** `npm run sync:gridstats` (`scripts/sync-gridstats.mjs`) is the whole GT7
  pipeline. It runs on the VPS every six hours (`goon` stack, `sync.sh gridstats`), then commits, pushes,
  rebuilds and republishes the site; `.github/workflows/sync-gridstats.yml` is the manual fallback. Two
  phases, both against GT-GridStats:
  1. **Player snapshots** from the documented token API (`GET /api/racers/{psn,...}`, 16 per request):
     DR/SR, nickname, country and the stats block (licence, Sport races, wins, poles, fastest laps, clean
     races...). Two requests per run. The account's daily quota is reported in `X-Quota-Limit` /
     `X-Quota-Remaining` on every response -- it was 5/day when the site was built and is **100/day** as
     of 2026-09-28, which is why this no longer waits for a once-a-day slot. The remaining count is
     written to `data/sync-status.json` each run.
  2. **Time Trial results** from the public, server-rendered player pages (`/player/{psn}`, paginated
     newest-first). The API has no event-listing or per-event-leaderboard endpoint (re-checked against the
     docs 2026-09-28), so this is still the only way to get times. Paging stops as soon as a page is older
     than the window below, so a run is a few dozen requests, not hundreds.

  Only Time Trials that **end in the current season, or ended in the last 21 days**, are touched. Closed
  seasons are the spreadsheet's and are never rewritten by the sync (see "Why the history is frozen").
  Players not indexed on GT-GridStats (six of the 24 on file) get no automatic results; their times go in
  through the issue form. dg-edge.com, the site's original source, was retired 2026-09-28: it had stopped
  showing per-player times a year earlier and only ever contributed event listings.
- **Two rules decide what an official Time Trial record is** (`scripts/lib/seasons.mjs`, shared by the
  sync, the issue-form processor, the historical importer and the integrity check, so none of them can
  drift from the others):
  1. **A Time Trial scores in the season it *closes* in.** That is how the crew's scoring spreadsheet
     always worked (a TT was logged, on whichever tab was current, the week it ended) and where
     `data/seasons.json`'s boundaries come from. When a season is closed and the next one opened in
     `seasons.json`, a TT that ends in the new season moves over on the next sync -- the boundary is
     entirely a property of that one file.
  2. **Two records are the same Time Trial when their track names match and their start dates *or* their
     end dates fall within three days of each other.** Spreadsheet rows carry one date (the week the TT
     closed); GT-GridStats carries the real two-week window. Comparing only start dates -- which the old
     scrapers did -- never matched the two, and quietly minted a GT-GridStats duplicate for ~150 of the
     spreadsheet's Time Trials, double-counting their points in every past season's standings until the
     2026-09-28 clean-up merged them.
- **Data integrity is checked after every sync.** `npm run verify:data` runs last, after the data is already
  committed, pushed and published, so a problem it finds never blocks or loses a sync -- it fails the run so
  it is seen. It enforces both rules above (no two files are the same TT in any season; every synced
  event is filed in the season it ends in), plus: every result points at a real event, every event at a
  real season, one row per player per event, ISO dates, known sources, no dg-edge leftovers.
- **Storage.** `data/official-events/<id>.json`, one file per Time Trial, with exactly these keys: `id`,
  `source` (`gridstats` | `historical` | `manual`), `seasonId`, `track`, `car`, `classCode`, `startDate`,
  `endDate` (ISO). No per-file timestamps or status flags, so a quiet sync changes nothing and makes no
  commit; the run itself is recorded once, in `data/sync-status.json`. New Time Trials get the id
  `tt-<start date>-<track slug>`; older ids (`590`, `gridstats-...`, `<season>-<track>-<date>`) are kept
  because the site's URLs are built from them. `data/results/official.json` holds every result, sorted by
  event and rank. `data/players.json` holds the roster and each player's GT-GridStats snapshot.
- **Time Trial results** -- official and custom -- feed points-based standings, grouped by season.
  The standings page defaults to the current season with a dropdown to browse any past season,
  each showing the season's overall standings plus a full breakdown of every Time Trial run that
  season. Per-event scoring is percent-off-pace: the fastest group time in an event scores 100,
  and every 1% off that pace costs 10 points. Season totals drop each player's worst-scoring
  events (an event you skipped entirely counts as a 0 for this purpose too, so skipping a couple
  events a season is effectively free) -- up to 2, scaling in with how many events the season has
  had so far (`floor(seasonEventCount / 3)`, capped at 2) so a brand new season's first few events
  don't get mostly discarded. Both rules match the crew's original scoring spreadsheet's formulas
  (`=IF(...,100-((time/MIN(...)-1)*1000))` per event, `=SUM(...)-SMALL(...,1)-SMALL(...,2)` for the
  season total), confirmed against real formulas in the crew's exported workbook and validated
  against 1200+ historical results.
- **Seasons.** `data/seasons.json`, hand-maintained, newest first, exactly one `current: true`. Autumn
  2026 opened 2026-09-25 (Summer 2026 closed 2026-09-24, the day its last Time Trial ended). To roll a
  season: give the current one an `endDate`, set `current: false`, add the new one on top with
  `endDate: null` -- the next sync re-files any Time Trial that ends in the new season.
- **Why the history is frozen.** 11 past seasons (2023 through Spring 2026) come from the crew's original
  scoring spreadsheet via `scripts/import-historical-seasons.mjs` (safe to re-run: it keeps each event's
  real window, GT7 track name and car, and any result for a player the sheet never had). The 2026-09-28
  merge folded the GT-GridStats copies of those Time Trials into the spreadsheet's records -- taking the
  real start/end window and GT7 spelling from GT-GridStats, the sheet's times where both had one, and
  adding 123 results for players the sheet had missed. The sync does not revisit closed seasons after
  that: the spreadsheet decides them.
- **The current season's still-running Time Trials** are called out as "Active" and shown up top
  with a track photo, ahead of the season's other (finished) events.
- **Each Time Trial's track and car link out to the [GT7 wiki](https://gran-turismo.fandom.com/wiki/Gran_Turismo_7)**
  (best-effort, guessed from the name on file; generic car-class entries like "Gr.3" are skipped), and
  events show a track photo when GT-GridStats has one under a matching name (same best-effort caveat).
- **Events, tune submissions, and championship round updates** all come in through GitHub Issue
  Forms, processed automatically into the site's data. The results form covers our own custom events
  and, marked as official, a Time Trial time the sync missed: it attaches to the synced record of that
  TT by rule 2 above, or creates a `manual` event the next sync will recognise rather than duplicate.
- **Team championship standings** track round-by-round points across the season, with roster names
  linked to player pages where the PSN is known.
- **Dates always display as "D MMM YYYY"** (e.g. "23 Jul 2026"); they are stored as ISO.
- **Tune archive** for GT7 car setups/parts lists, browsable by car.
- The site rebuilds and redeploys automatically on every data update.

All data lives in `data/` as version-controlled JSON; `scripts/` holds the sync/processing jobs
and `.github/workflows/` the issue-driven processors and manual fallbacks.

## Look

Since 2026-09-26 the site wears the family chrome from music.subch.us and subch.us (Audiowide
headings, Monoton neon wordmark, striped sun, drifting sky glows) in its own colourway: **BLACK**.
music.subch.us is the bright vapor, subch.us the medium purple/lava one, this is the true-black one
with thin pink and cyan neon. Everything is tokens on `:root` in `src/styles/global.css` (`--a`,
`--b`, `--c`, `--y`, `--g1..3`); the older names the pages use (`--bg`, `--accent`, `--text-dim`...)
are mapped onto them, so a colourway change is one block. Grounds stay near-black and blue stays out
of the foreground (the owner's TV turns saturated dark blue electric). No raster art anywhere.

## Racing (`/racing/`)

Real-world results in one place, for the crew. Two tiers on the overview: **MotoGP (+Moto2/Moto3),
WEC (Hypercar/LMGT3, plus LMP2 at Le Mans) and F1** on top, then **WorldSBK (+WorldSSP), WRC,
MotoAmerica (Superbike, Supersport, Twins Cup, King of the Baggers, Super Hooligan), the NASCAR Cup
Series (with the playoff standings), Formula E and IndyCar** below. Each series gets a season page (standings +
calendar with the race winner per round) and an event page per round (every session, in order, with
its classification once published). Session times are stored in UTC and rewritten into the viewer's own
timezone in the browser; the overview shows what's next and who won last for every series.

- **Sources are each series' own public results pages or an open API**, credited in every page
  footer: Jolpica (the Ergast successor) for F1; the JSON behind motogp.com, worldsbk.com, wrc.com
  and nascar.com's own results pages; fiawec.com's race pages and results browser for WEC;
  fiaformulae.com's server-rendered results page for Formula E; indycar.com's own results API; the
  official timing PDFs for MotoAmerica (MyLaps Orbits), parsed to text. IMSA and BTCC were left out:
  their sites sit behind bot challenges and the only other sources (Al Kamel, TSL Timing) publish
  under no-scraping terms. What is kept
  is the classification (position, number, name/car, team, class, laps, time, gap, points) -- no
  logos, photos, video or live timing, ever. Al Kamel's WEC timing site is deliberately not used: it
  carries an explicit no-redistribution notice. Details, per-series caveats and the "how to add a
  series" recipe are in `scripts/racing/series/README.md`; the data shape in
  `scripts/racing/lib/schema.mjs`.
- **`npm run scrape:racing`** writes `data/racing/<series>/<season>.json`. It is incremental: events
  already marked complete are reused, so a steady-state run is a few dozen spaced requests. Pass
  `--full` after fixing a parser, `--series f1,wec` to limit it, `--season 2025` for a past season
  (a past season on file gets its own page and appears in the season dropdown).
- **One broken source never blocks the others.** A failing adapter warns and leaves its previous
  file in place; the run still exits 0 so the VPS sync commits, builds and publishes the rest. The
  page shows when each series last synced, which is how a stale one gets noticed. A source that
  answers with an empty season is refused (same idea as sync.sh's shrink guard).
- **Sprint points are shown next to the total** wherever a class scores more than the race (MotoGP
  and F1 sprints, WSBK's Superpole Race): "Sprint pts" / "Race pts" columns on the riders' table,
  summed from the session classifications. WSBK's and MotoAmerica's feeds carry no points, so those
  are computed from the official scales (25-20-16... for races, 12-9-7... for the Superpole Race;
  MotoAmerica by position within the rider's class) -- the standings themselves stay as published.
- **Every named driver has a season page** (`/racing/<series>/<season>/driver/<class>--<slug>/`):
  standing, starts, wins, podiums, best finish, the sprint/race split, and every classified
  session in calendar order. Names in standings and results tables link to it. WEC results are cars,
  not people, so it has none.
- **Every circuit has a page** (`/racing/tracks/`, `/racing/tracks/<slug>/`): a drawn layout,
  the facts (length, turns, location, opened, capacity, layouts, an "elevation change" sentence when
  the article has one, coordinates with a map link) and every event on file held there across all
  series with its winners. The layout is the article's SVG track map from Wikimedia Commons (the
  drawn ones with numbered turns) where there is one, downloaded once to `public/tracks/<slug>.svg`
  with scripts stripped and its author/licence credited under it; otherwise an outline drawn here
  from OpenStreetMap's raceway ways (no turn numbers, and the page says so). Raster maps are never
  used. `npm run scrape:tracks` builds `data/racing/tracks.json` from the circuit names in the
  season files plus `data/racing/track-aliases.json` (hand-kept names for WEC, IndyCar, Formula E
  and MotoAmerica, whose feeds carry no circuit); a wrong Wikipedia match, or a wrong map, is fixed in
  `data/racing/track-overrides.json` (`"<series>:<name>": "<title>"`, `"layout:<slug>":
  "<File.svg>"` or `"osm"`) and `--full`; `--relayout` retries only the drawings that are missing.
  It runs at the end of every full `scrape:racing` and only fetches circuits it hasn't seen.
  Wikipedia facts are CC BY-SA and credited on every page.
- **Past seasons are on file back to 2020** (`npm run scrape:racing -- --season 2023`); every season
  gets its own pages and the season dropdown, and track pages list every season's races. A season
  is roughly 12 MB of JSON, 1,300 pages and 1,500 spaced requests the first time, then never
  refetched. Two sources only cover the present: WEC's results browser offers the current and
  previous season and its standings page only the current one (past WEC seasons have no standings);
  motoamerica.com's points table is current-season only, so past MotoAmerica standings are summed
  from the per-race points (the table says so).
- **Scheduled on the VPS** (`goon` stack, `sync.sh racing`, every two hours);
  `.github/workflows/sync-racing.yml` is the manual fallback.

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

Run the data jobs locally (they write into `data/`):

```bash
GT_GRIDSTATS_TOKEN=xxx npm run sync:gridstats   # GT7: players (API, 2 of 100 requests/day) + Time Trial results (public pages); token optional
npm run verify:data                             # data integrity check (both rules + references)
npm run scrape:racing                           # /racing/ results (add -- --full to refetch everything)
```
