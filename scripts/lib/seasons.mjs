// Shared season-matching helpers used by every scraper that needs to figure
// out which season (data/seasons.json) a scraped date falls into.

/**
 * Find the season whose [startDate, endDate] range (ISO YYYY-MM-DD, endDate
 * null meaning open-ended/current) contains the given ISO date. Returns null
 * if the date falls in a gap between tracked seasons.
 */
export function seasonForDate(iso, seasons) {
  return seasons.find((s) => iso >= s.startDate && (!s.endDate || iso <= s.endDate)) ?? null;
}

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Parse "6 August 2026" / "06 Aug 2026" (day, full or abbreviated month
 * name, year -- the two date formats seen across dg-edge.com and
 * GT-GridStats) into an ISO YYYY-MM-DD string for comparison against season
 * boundaries. Returns null if the string doesn't match.
 */
export function humanDateToIso(d) {
  if (!d) return null;
  const m = d.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${mo}-${m[1].padStart(2, '0')}`;
}

/** Like humanDateToIso, but passes an already-ISO date straight through
 * (historical/spreadsheet-imported events store dates as ISO already). */
export function toIso(d) {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return humanDateToIso(d);
}

// Generic venue-type words that get spelled inconsistently between sources
// for the *same* real track ("24 Heures du Mans Racing Circuit" vs "24
// Heures du Mans race track", "Daytona International Speedway - Road
// Course" vs "Daytona Road Course") -- stripped before comparing so those
// still match. Layout-distinguishing words (reverse, short, east, west...)
// are deliberately NOT in this list, since those really do mean a different
// track variant that shouldn't be merged.
const GENERIC_VENUE_WORDS = new Set([
  'international', 'speedway', 'raceway', 'racing', 'circuit', 'track', 'race', 'motor', 'course',
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
// tokensLooselyMatch below, so short/generic-looking tokens ("gt", "sh")
// can't accidentally prefix-match something unrelated.
const MIN_PREFIX_MATCH_LEN = 4;

/**
 * True if two same-length, sorted token lists represent the same track
 * layout under minor naming differences -- e.g. GT-GridStats calling a
 * layout "Short Course" where dg-edge calls it "Shortcut Course" (confirmed
 * 2026-08-20: same real Autopolis TT, described differently by each site).
 * Every token pair must be exactly equal, or one a prefix of the other (at
 * least MIN_PREFIX_MATCH_LEN chars) -- this is intentionally strict so it
 * doesn't merge genuinely different variants (e.g. "east"/"west", "short"
 * next to an unrelated word that happens to share a prefix).
 */
function tokensLooselyMatch(a, b) {
  if (a.length !== b.length) return false;
  return a.every((tokenA, i) => {
    const tokenB = b[i];
    if (tokenA === tokenB) return true;
    const [shorter, longer] = tokenA.length <= tokenB.length ? [tokenA, tokenB] : [tokenB, tokenA];
    return shorter.length >= MIN_PREFIX_MATCH_LEN && longer.startsWith(shorter);
  });
}

const EVENT_DATE_TOLERANCE_DAYS = 3;

/**
 * Build a lookup of every existing event, grouped by (season, normalized
 * track), for matching a newly-scraped event against ones that already
 * exist from a *different* source. dg-edge and GT-GridStats both discover
 * the same real-world Time Trials independently under different ids and
 * naming, so without this every scraper run mints a fresh duplicate event
 * for something that's already tracked. Also keeps a per-season list (with
 * each event's token breakdown) as a fallback for near-miss track-name
 * matching -- see findMatchingEventId.
 */
export function buildEventMatchIndex(events) {
  const byKey = new Map();
  const bySeason = new Map();
  for (const ev of events) {
    if (!ev?.seasonId || !ev.track) continue;
    const iso = toIso(ev.startDate);
    if (!iso) continue;
    const tokens = trackTokens(ev.track);
    const entry = { id: ev.id, iso, tokens };

    const key = `${ev.seasonId}|${tokens.join('')}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry);

    if (!bySeason.has(ev.seasonId)) bySeason.set(ev.seasonId, []);
    bySeason.get(ev.seasonId).push(entry);
  }
  return { byKey, bySeason };
}

/**
 * Find an existing event's id matching (seasonId, track, ~date), or null if
 * none of the already-known events look like the same real-world Time Trial.
 * Tries an exact normalized-track match first; if that finds nothing within
 * the date tolerance, falls back to a looser token-prefix comparison across
 * every event in the same season (still gated by the same date tolerance,
 * so two genuinely different TTs starting around the same date -- which
 * does happen -- won't collide, since their track tokens won't loosely
 * match each other).
 */
export function findMatchingEventId(index, seasonId, track, iso) {
  if (!iso) return null;
  const tokens = trackTokens(track);
  const key = `${seasonId}|${tokens.join('')}`;
  const exactCandidates = index.byKey.get(key) ?? [];
  for (const c of exactCandidates) {
    const days = Math.abs((new Date(c.iso) - new Date(iso)) / 86_400_000);
    if (days <= EVENT_DATE_TOLERANCE_DAYS) return c.id;
  }

  const seasonCandidates = index.bySeason.get(seasonId) ?? [];
  for (const c of seasonCandidates) {
    if (!tokensLooselyMatch(tokens, c.tokens)) continue;
    const days = Math.abs((new Date(c.iso) - new Date(iso)) / 86_400_000);
    if (days <= EVENT_DATE_TOLERANCE_DAYS) return c.id;
  }
  return null;
}
