// Shared season and event-identity helpers for everything that reads or
// writes data/official-events: the GT-GridStats sync, the issue-form
// processor, the historical importer and the integrity check. Keeping the
// rules here means the check can never be stricter or looser than the code
// that created the data.
//
// THE TWO RULES (settled 2026-09-28, after the end-date/start-date mix-up
// duplicated most of the spreadsheet history):
//
//   1. A Time Trial belongs to the season in which it CLOSES. That is how the
//      crew's scoring spreadsheet always worked - a TT was logged, on whichever
//      tab was current, the week it ended - and seasons.json's boundaries were
//      taken from those tabs. So season = seasonForDate(endDate).
//   2. Two records are the SAME Time Trial when their track names match and
//      either their start dates or their end dates fall within a few days of
//      each other. Spreadsheet-imported events carry one date (the week the
//      TT closed), GT-GridStats rows carry the real two-week window; comparing
//      only start dates never matched the two, which is what minted the
//      duplicates.

/**
 * Find the season whose [startDate, endDate] range (ISO YYYY-MM-DD, endDate
 * null meaning open-ended/current) contains the given ISO date. Returns null
 * if the date falls in a gap between tracked seasons.
 */
export function seasonForDate(iso, seasons) {
  if (!iso) return null;
  return seasons.find((s) => iso >= s.startDate && (!s.endDate || iso <= s.endDate)) ?? null;
}

/** Rule 1: the season a Time Trial scores in is the one its end date falls in. */
export function seasonForEvent(ev, seasons) {
  return seasonForDate(toIso(ev.endDate) ?? toIso(ev.startDate), seasons);
}

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Parse "6 August 2026" / "06 Aug 2026" (day, full or abbreviated month
 * name, year -- the format GT-GridStats renders) into ISO YYYY-MM-DD.
 * Returns null if the string doesn't match.
 */
export function humanDateToIso(d) {
  if (!d) return null;
  const m = d.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${mo}-${m[1].padStart(2, '0')}`;
}

/** Like humanDateToIso, but passes an already-ISO date straight through.
 * Stored dates are all ISO since 2026-09-28; this stays tolerant for input. */
export function toIso(d) {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return humanDateToIso(d);
}

export function daysBetween(isoA, isoB) {
  return Math.abs((new Date(isoA) - new Date(isoB)) / 86_400_000);
}

// Generic venue-type words that get spelled inconsistently between sources
// for the *same* real track ("24 Heures du Mans Racing Circuit" vs "24
// Heures du Mans race track", "Circuit de Sainte-Croix - Layout B Reverse" vs
// "Circuit de Sainte-Croix - B Reverse") -- stripped before comparing so
// those still match. Layout-distinguishing words (reverse, short, east,
// west...) are deliberately NOT in this list, since those really do mean a
// different track variant that shouldn't be merged.
const GENERIC_VENUE_WORDS = new Set([
  'international', 'speedway', 'raceway', 'racing', 'circuit', 'track', 'race', 'motor', 'course', 'layout',
]);

export function trackTokens(name) {
  const words = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !GENERIC_VENUE_WORDS.has(w));
  words.sort();
  return words;
}

export function normalizeTrack(name) {
  return trackTokens(name).join('');
}

// Minimum token length eligible for prefix-only matching in
// tracksMatch below, so short/generic-looking tokens ("gt", "sh")
// can't accidentally prefix-match something unrelated.
const MIN_PREFIX_MATCH_LEN = 4;

/**
 * True if two track names describe the same layout under minor naming
 * differences -- e.g. GT-GridStats calling a layout "Short Course" where
 * another listing says "Shortcut Course" (confirmed 2026-08-20: same real
 * Autopolis TT). Every token pair must be exactly equal, or one a prefix of
 * the other (at least MIN_PREFIX_MATCH_LEN chars) -- intentionally strict so
 * it doesn't merge genuinely different variants (east/west, a forward layout
 * with its reverse).
 */
export function tracksMatch(nameA, nameB) {
  const a = trackTokens(nameA);
  const b = trackTokens(nameB);
  if (a.length === 0 || a.length !== b.length) return false;
  return a.every((tokenA, i) => {
    const tokenB = b[i];
    if (tokenA === tokenB) return true;
    const [shorter, longer] = tokenA.length <= tokenB.length ? [tokenA, tokenB] : [tokenB, tokenA];
    return shorter.length >= MIN_PREFIX_MATCH_LEN && longer.startsWith(shorter);
  });
}

export const EVENT_DATE_TOLERANCE_DAYS = 3;

/**
 * Rule 2: same Time Trial if the tracks match and the start dates OR the end
 * dates are within EVENT_DATE_TOLERANCE_DAYS of each other. Either record may
 * carry only one date (a spreadsheet import), in which case that date stands
 * for both its start and its end.
 */
export function sameTimeTrial(a, b) {
  if (!tracksMatch(a.track, b.track)) return false;
  const sa = toIso(a.startDate) ?? toIso(a.endDate);
  const ea = toIso(a.endDate) ?? sa;
  const sb = toIso(b.startDate) ?? toIso(b.endDate);
  const eb = toIso(b.endDate) ?? sb;
  if (!sa || !sb) return false;
  return daysBetween(sa, sb) <= EVENT_DATE_TOLERANCE_DAYS || daysBetween(ea, eb) <= EVENT_DATE_TOLERANCE_DAYS;
}

/**
 * The existing event (from `events`, any season, any source) that is the
 * same Time Trial as `candidate` ({track, startDate, endDate}), or null.
 * Prefers an exact normalized-track match over a loose one when several
 * qualify.
 */
export function findMatchingEvent(events, candidate) {
  let loose = null;
  for (const ev of events) {
    if (!sameTimeTrial(ev, candidate)) continue;
    if (normalizeTrack(ev.track) === normalizeTrack(candidate.track)) return ev;
    loose ??= ev;
  }
  return loose;
}

export function slugify(str) {
  return String(str ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Id for a newly discovered official Time Trial: tt-<start ISO>-<track slug>. */
export function officialEventId(track, startIso) {
  return `tt-${startIso}-${slugify(track)}`;
}

/** Canonical key order for an official-event record, so files diff cleanly. */
const EVENT_KEYS = ['id', 'source', 'seasonId', 'track', 'car', 'classCode', 'startDate', 'endDate', 'notes'];
export function canonicalEvent(ev) {
  const out = {};
  for (const k of EVENT_KEYS) if (ev[k] !== undefined) out[k] = ev[k];
  return out;
}
