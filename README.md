# Goon Turismo

Tracks our crew's participation in Gran Turismo 7 Time Trials — both the official
ones tracked by [dg-edge.com](https://www.dg-edge.com/events/time-trials) and our
own custom group events — with a season standings/points system, hosted as a
static site on GitHub Pages at **goon-turismo.com**.

## How it works

- **`data/`** is the database — plain JSON files, version-controlled.
  - `players.json` — the friends we're tracking (PSN + display name + cached dg-edge stats).
  - `seasons.json` — season definitions (start/end dates, which one is current).
  - `official-events/*.json` + `results/official.json` — auto-populated by the dg-edge scraper.
  - `custom-events/*.json` + `results/custom.json` — populated when someone submits a custom event.
  - `points-config.json` — how group rank converts to points. **Placeholder values right now** —
    update once we've pulled the real scoring system from the old spreadsheet.
- **`scripts/scrape-dg-edge.mjs`** runs on a schedule (`.github/workflows/scrape-dg-edge.yml`, every
  6 hours) via GitHub Actions: fetches each tracked player's dg-edge profile and the current
  time-trials listing, updates the JSON above, and commits the changes.
- **Custom events** are submitted via a [GitHub Issue Form](.github/ISSUE_TEMPLATE/custom-event-result.yml)
  (linked from the site's "Submit Event" page). `.github/workflows/process-custom-event.yml` parses
  new submissions, writes the result data, comments on and closes the issue.
- **`.github/workflows/deploy.yml`** builds the Astro site and deploys it to GitHub Pages on every
  push to `main` (including the automated data-update commits above, so the live site refreshes
  itself).

## Local development

```bash
npm install
npm run dev
```

Run the scraper locally (writes into `data/`):

```bash
npm run scrape:dg-edge
```

## ⚠️ Things that still need attention

1. **dg-edge.com scraper selectors.** I built `scrape-dg-edge.mjs` without being able to inspect
   dg-edge's live HTML directly (no browser access at build time) — it matches on visible label
   text (e.g. "Edge Score", "Events Attended") rather than CSS classes, which is more resilient but
   not guaranteed. **Check the first few runs** under the repo's Actions tab → "Scrape dg-edge.com".
   If it's logging `WARN` lines about missing stats or missing event links, open the relevant
   dg-edge page, compare its actual layout to the `extractStatByLabel(...)` calls near the top of
   the script, and adjust. If the events list turns out to be rendered client-side (loaded via JS
   after page load) rather than in the initial HTML, the fetch-based approach won't see it and the
   script will need to switch to a headless browser (Playwright) instead — I can wire that up if so.
2. **Points system.** `data/points-config.json` currently uses placeholder values (20 points for 1st,
   down to 1 point for anyone finishing outside the top 15). Once the historical Google Sheet data
   is available, update this file (and re-run the scraper / re-process events) to match your actual
   scoring system.
3. **Historical data harvest.** Per your call to move off Sheets going forward, this is meant as a
   **one-time import** to seed history — export the relevant tab(s) of the old sheet as CSV and
   I'll write a one-off script to convert it into `data/results/*.json` + `data/official-events/` /
   `data/custom-events/` entries, then it's out of the loop for good.
4. **Friends' PSNs.** Only `superpharts` is seeded in `data/players.json` right now. Add more
   entries (same shape) and the scraper/site pick them up automatically on the next run.

## Pointing goon-turismo.com at this site

GitHub Pages is already configured to serve this repo at the custom domain via the `CNAME` file at
the repo root (already set to `goon-turismo.com`). Two things need to happen in GitHub's repo
settings and at your domain registrar/DNS provider:

1. **DNS records** — at wherever `goon-turismo.com` is registered, add:
   - Four `A` records for the apex domain (`goon-turismo.com`) pointing at GitHub Pages' IPs:
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - Optionally, a `CNAME` record for `www` → `subch.github.io` if you also want `www.goon-turismo.com`
     to work.
2. **GitHub repo settings** — under Settings → Pages, set the custom domain to `goon-turismo.com` and
   enable "Enforce HTTPS" once GitHub finishes issuing the certificate (can take a little while after
   DNS propagates).

## Points-of-contact for this project

This repo lives alongside the `goon-turismo.com` site and is meant to fully replace the manual
spreadsheet for anything ongoing — the spreadsheet is only used once, for the historical backfill.
