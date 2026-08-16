# Goon Turismo

Tracks our crew's participation in Gran Turismo 7 Time Trials — both the official
ones tracked by [dg-edge.com](https://www.dg-edge.com/events/time-trials) and our
own custom group events — plus team championship standings and a tune/parts-list
archive, hosted as a static site on GitHub Pages at **goon-turismo.com**.

## How it works

- **`data/`** is the database — plain JSON files, version-controlled.
  - `players.json` — the friends we're tracking (PSN + display name + cached dg-edge stats).
  - `seasons.json` — season definitions (start/end dates, which one is current).
  - `official-events/*.json` + `results/official.json` — dg-edge-tracked events. Aggregate stats
    are auto-scraped; most individual results come in via the same submission form as custom
    events (see the important caveat below).
  - `custom-events/*.json` + `results/custom.json` — populated when someone submits a custom event.
  - `tunes/*.json` — GT7 car setups/parts lists, populated via the "Submit a tune" issue form.
  - `championships/*.json` — team championship seasons (modeled on the "Goon Standings" sheet),
    updated via the "Update championship standings" issue form.
  - `points-config.json` — how group rank converts to points for time trial events.
    **Placeholder values right now** — update once we've pulled the real scoring system from the
    old spreadsheet.
- **`scripts/scrape-dg-edge.mjs`** runs on a schedule (`.github/workflows/scrape-dg-edge.yml`, every
  6 hours) via GitHub Actions: fetches each tracked player's dg-edge profile and the current
  time-trials listing, updates the JSON above, and commits the changes.
  **⚠️ Verified limitation (checked by hand against the live site 2026-08-16):** dg-edge only shows
  a player's own event-by-event result history when *that player* is logged into their own dg-edge
  account — viewing someone else's profile (even while logged in as someone else) shows it empty.
  The site's leaderboard tables also only render the top slice of each event (roughly the first
  ~250 entries as the page loads/scrolls), and there's no working public "look up this player's
  time in this event" search despite there being a search box on the page. So: player aggregate
  stats (Edge Score, Events Attended, etc.) reliably auto-update, but **most friends' individual
  official-event times will not show up automatically** unless they happen to rank near the top of
  that event. The practical path for official-event results is the same manual submission flow as
  custom events (below) — just fill in the optional dg-edge link field.
- **Events and official-event results** are submitted via a
  [GitHub Issue Form](.github/ISSUE_TEMPLATE/custom-event-result.yml) (linked from the site's
  "Submit Event" page) — leave the "Official dg-edge event link" field blank for a custom event, or
  fill it in to attach results to a real dg-edge Time Trial.
  `.github/workflows/process-custom-event.yml` parses new submissions, writes the result data,
  comments on and closes the issue.
- **Tunes** are submitted via [`.github/ISSUE_TEMPLATE/submit-tune.yml`](.github/ISSUE_TEMPLATE/submit-tune.yml)
  (linked from `/tunes/`), processed by `.github/workflows/process-tune-submission.yml`.
- **Championship standings** are reported round-by-round via
  [`.github/ISSUE_TEMPLATE/update-championship.yml`](.github/ISSUE_TEMPLATE/update-championship.yml)
  (linked from each championship's page), processed by `.github/workflows/process-championship-update.yml`.
  Adding/removing teams or rosters, or starting a new season, is a direct edit to
  `data/championships/<season-id>.json` (or a new file + entry in `data/championships/index.json`).
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

1. **dg-edge.com individual event results are mostly manual.** See the verified limitation above —
   this is the single biggest scope change from the original plan. If dg-edge ever ships a real
   player/event lookup API, `scrape-dg-edge.mjs` should switch to it.
2. **Points system.** `data/points-config.json` currently uses placeholder values (20 points for 1st,
   down to 1 point for anyone finishing outside the top 15). Once the historical Google Sheet data
   is available, update this file (and re-run the scraper / re-process events) to match your actual
   scoring system.
3. **Historical data harvest is incomplete.** Both source sheets have many more season tabs (12 on
   the TT sheet, 15 on the championship "Goon Standings" sheet) than what's been pulled in so far —
   bulk CSV export hit Google's rate limit mid-run. This still needs a slower, one-at-a-time pass
   (or CSVs exported by hand and attached) to fully backfill history; only the current/most recent
   season is seeded right now.
4. **Championship roster mapping needs confirming.** `data/championships/2026-fall-championship.json`
   was seeded from the sheet's team colors/nicknames. Most names matched a tracked PSN confidently
   (Rickie→rickiep00h, Kirios→kirios86, Wombat→wombatvet, Dev→devmotron, Ashy→ashy_wenises,
   Empire→empire_of_ravens, Sinderby→sinder_22), but **"Dr K", "Fairfax", "Rammy", and "Crockhaed"**
   (guessed as craigrackhaed) are marked `(unconfirmed PSN)` in the roster and need a real person to
   confirm. `doug_nougat`, `abner_assington`, `ainsliespeed`, `braveman84`, `fenix_down1`, and
   `vitti1107` aren't on a team in this file yet either (possibly reserve drivers).
5. **Friends' PSNs.** All 15 are now seeded in `data/players.json`.

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
