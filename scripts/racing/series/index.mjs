// Every series the racing pages know about, in the order they appear on
// /racing/. To add one: write scripts/racing/series/<id>.mjs exporting the
// same six things these do (id, name, shortName, source, and fetchSeason;
// `classes` may be static or come back from fetchSeason) and import it here.
// See README.md in this folder.
import * as f1 from './f1.mjs';
import * as motogp from './motogp.mjs';
import * as wec from './wec.mjs';
import * as wsbk from './wsbk.mjs';

export const SERIES = [f1, motogp, wec, wsbk];

export function seriesById(id) {
  return SERIES.find((s) => s.id === id);
}
