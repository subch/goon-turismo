// Every series the racing pages know about, in display order. To add one:
// write scripts/racing/series/<id>.mjs exporting the same things these do
// (id, name, shortName, tier, source, fetchSeason; `classes` may be static
// or come back from fetchSeason) and import it here. See README.md in this
// folder.
//
// Tiers: 'main' is the three the crew follows closest and gets the wide
// cards at the top of /racing/; 'other' is everything else, in this order
// below them. Keep the order here in step with SERIES_ORDER in
// src/lib/racing.ts.
import * as motogp from './motogp.mjs';
import * as wec from './wec.mjs';
import * as f1 from './f1.mjs';
import * as wsbk from './wsbk.mjs';
import * as wrc from './wrc.mjs';
import * as motoamerica from './motoamerica.mjs';
import * as nascar from './nascar.mjs';
import * as formulae from './formulae.mjs';

export const SERIES = [motogp, wec, f1, wsbk, wrc, motoamerica, nascar, formulae];

const MAIN = new Set(['motogp', 'wec', 'f1']);

export function tierOf(series) {
  return series.tier ?? (MAIN.has(series.id) ? 'main' : 'other');
}

export function seriesById(id) {
  return SERIES.find((s) => s.id === id);
}
