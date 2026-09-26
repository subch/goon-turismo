# Racing series adapters

One file per series. Each turns a public source into the one shape the
`/racing/` pages render, documented at the top of `../lib/schema.mjs`. The
runner (`scripts/scrape-racing.mjs`, `npm run scrape:racing`) calls every
adapter listed in `index.mjs` and writes `data/racing/<id>/<season>.json`.

## Adding a series

1. Find a source that is (a) the series' own site or an openly licensed API,
   and (b) not a timing provider's page with a redistribution notice. Results
   tables (who finished where, in what time) are what we keep; logos, photos,
   live timing and video are never fetched. If the only source you can find
   carries a "no redistribution" notice, link out instead of scraping.
2. Create `<id>.mjs` exporting:

   ```js
   export const id = 'indycar';                 // URL slug: /racing/indycar/
   export const name = 'IndyCar Series';
   export const shortName = 'IndyCar';
   export const source = { name: '...', url: '...' };   // credited on the page
   export const classes = [{ id: 'indycar', name: 'IndyCar' }];  // optional if fetchSeason returns them
   export async function fetchSeason({ season, previous, full, log }) {
     // previous = the file written last time (or null); reuse any event it
     // already has `complete: true` unless `full` is set.
     return { classes, events, standings };
   }
   ```

   Use `request`/`getJson`/`getText` from `../lib/http.mjs` (User-Agent,
   spacing, retries) and the `result()`/`standingRow()` helpers from
   `../lib/schema.mjs` so every row has every field.
3. Import it in `index.mjs` and add the id to `SERIES_ORDER` in
   `src/lib/racing.ts` if it should sit somewhere specific on `/racing/`.
4. `npm run scrape:racing -- --series <id>` then `npm run build`. The pages
   need no changes: they are generated from whatever files exist under
   `data/racing/`.

## Current sources

Tier `main` (top of /racing/): MotoGP, WEC, F1. Tier `other`: the rest.

| Series | Source | Notes |
| --- | --- | --- |
| MotoGP | motogp.com results API | undocumented JSON the official site uses; MotoGP/Moto2/Moto3 |
| WEC | fiawec.com | race pages + results live-component; Hypercar/LMGT3 (+LMP2 at Le Mans); cars not drivers in results |
| F1 | Jolpica API (Ergast successor) | documented, open; no free-practice times |
| WSBK | worldsbk.com sport-data API | undocumented JSON the official site uses; WorldSBK/WorldSSP |
| WRC | wrc.com results feed (p-p.redbull.com) | JSON the official site loads; overall classification + 3 championship tables; stage times left to the site |
| MotoAmerica | results.motoamerica.com + motoamerica.com | session catalogue embedded in the archive page; every classification is a MyLaps Orbits PDF (parsed); standings from the points table; no session times |
| NASCAR Cup | cf.nascar.com "cacher" feeds | JSON nascar.com uses; race + qualifying, playoff standings (seeded drivers with playoff/stage points) and full season points; some race folders 403 until the weekend |
| Formula E | fiaformulae.com results page | server-rendered, plain query params; seasons numbered from 2014-15 (the file year is the season's end year, label kept in `seasonLabel`); no session times |
| IndyCar | indycar.com results API | JSON the official site uses (SeasonDropDown → events → session ids; EventsSessionDetails; YearPointSummary); every listed session; dates only, no start times |

MotoAmerica's PDFs go through `../lib/pdf.mjs`; that parser is the fragile
part of this folder, so `--full` after touching it.

Looked at and left out:

- **IMSA** -- imsa.com sits behind a Cloudflare challenge for anything that
  isn't a real browser, and the only other source is Al Kamel's (see above).
- **BTCC** -- btcc.net sits behind a Vercel security checkpoint, and the
  series' timing provider (TSL Timing) publishes the PDFs under terms that
  forbid crawling, scraping and republishing without written consent. Same
  class of risk as Al Kamel, so no.
- **NLS** -- was in for a day; dropped 2026-09-26 at the crew's request. Its
  wige-PDF parser lives in git history if ever wanted.

Al Kamel Systems (WEC's timing provider) is deliberately not used: its results
site says third-party distribution of its data without consent "will lead to
legal action".
