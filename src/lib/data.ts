// Central place that loads and joins all the JSON data files under /data
// so pages don't have to duplicate glob/import logic.
import playersData from '../../data/players.json';
import seasonsData from '../../data/seasons.json';
import officialResultsData from '../../data/results/official.json';
import customResultsData from '../../data/results/custom.json';

export type Player = {
  psn: string;
  displayName: string;
  active: boolean;
  joinedSeason: string;
  dgEdgeUrl?: string;
  note?: string;
  stats?: {
    edgeScore: number | null;
    globalPosition: number | null;
    countryPosition: number | null;
    eventsAttended: number | null;
    avgDelta: string | number | null;
    lastScraped: string | null;
  };
  gridstats?: {
    nickname: string | null;
    dr: string | number | null;
    sr: string | number | null;
    countryCode: string | null;
    stats: Record<string, unknown> | null;
    lastSynced: string | null;
  };
};

export type Season = {
  id: string;
  name: string;
  startDate: string;
  endDate: string | null;
  current: boolean;
};

export type EventRecord = {
  id: string;
  source: 'dg-edge' | 'gridstats' | 'custom' | 'historical';
  seasonId?: string | null;
  track?: string | null;
  car?: string | null;
  classCode?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  status?: string | null;
  dgEdgeUrl?: string | null;
  name?: string | null; // custom events
  date?: string | null; // custom events
  notes?: string | null;
};

export type ResultRow = {
  eventId: string;
  psn: string;
  timeRaw: string | null;
  timeMs: number | null;
  groupRank: number | null;
  points: number;
  scrapedAt?: string;
};

const officialEventModules = import.meta.glob<{ default: EventRecord }>('../../data/official-events/*.json', {
  eager: true,
});
const customEventModules = import.meta.glob<{ default: EventRecord }>('../../data/custom-events/*.json', {
  eager: true,
});
const tuneModules = import.meta.glob<{ default: Tune }>('../../data/tunes/*.json', { eager: true });
const championshipModules = import.meta.glob<{ default: Championship }>('../../data/championships/*.json', {
  eager: true,
});

export type Tune = {
  id: string;
  car: string;
  owner: string;
  class?: string | null;
  drivetrain?: string | null;
  description?: string;
  parts: { category: string; name: string }[];
  settings: Record<string, string>;
  notes?: string;
  createdFromIssue?: number | null;
};

export type ChampionshipRound = { id: string; track: string; date: string };
export type ChampionshipTeamResult = { place: number | null; poleFl: number; points: number };
export type ChampionshipTeam = {
  id: string;
  name: string;
  color?: string;
  roster: string[];
  results: Record<string, ChampionshipTeamResult>;
  totalPoints: number;
};
export type Championship = {
  id: string;
  name: string;
  format: string;
  rounds: ChampionshipRound[];
  teams: ChampionshipTeam[];
  sourceNote?: string;
};

function modulesToEvents(modules: Record<string, { default: EventRecord }>): EventRecord[] {
  return Object.entries(modules)
    .filter(([file]) => !file.endsWith('index.json'))
    .map(([, mod]) => mod.default)
    .filter(Boolean);
}

export const players: Player[] = playersData as Player[];
export const seasons: Season[] = seasonsData as Season[];
export const officialEvents: EventRecord[] = modulesToEvents(officialEventModules);
export const customEvents: EventRecord[] = modulesToEvents(customEventModules);
export const allEvents: EventRecord[] = [...officialEvents, ...customEvents];
export const allResults: ResultRow[] = [
  ...(officialResultsData as ResultRow[]),
  ...(customResultsData as ResultRow[]),
];

export const tunes: Tune[] = Object.entries(tuneModules)
  .filter(([file]) => !file.endsWith('index.json'))
  .map(([, mod]) => mod.default)
  .filter(Boolean);

export const championships: Championship[] = Object.entries(championshipModules)
  .filter(([file]) => !file.endsWith('index.json'))
  .map(([, mod]) => mod.default)
  .filter(Boolean);

export function championshipById(id: string): Championship | undefined {
  return championships.find((c) => c.id === id);
}

export function tuneById(id: string): Tune | undefined {
  return tunes.find((t) => t.id === id);
}

export function currentSeason(): Season | undefined {
  return seasons.find((s) => s.current) ?? seasons[0];
}

export function playerByPsn(psn: string): Player | undefined {
  return players.find((p) => p.psn.toLowerCase() === psn.toLowerCase());
}

export function eventById(id: string): EventRecord | undefined {
  return allEvents.find((e) => e.id === id);
}

export function resultsForEvent(eventId: string): ResultRow[] {
  return allResults.filter((r) => r.eventId === eventId).sort((a, b) => (a.groupRank ?? 999) - (b.groupRank ?? 999));
}

export function resultsForPlayer(psn: string): ResultRow[] {
  return allResults.filter((r) => r.psn.toLowerCase() === psn.toLowerCase());
}

export function eventLabel(e: EventRecord): string {
  return e.name || e.track || e.id;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LOOKUP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Every date on the site displays as "D MMM YYYY" (e.g. "23 Jul 2026"),
 * regardless of which of the two raw formats it's stored in -- ISO
 * (historical/spreadsheet-imported events) or "D Month YYYY" /
 * "DD Mon YYYY" (dg-edge/GT-GridStats scraped events). Pure string
 * parsing, deliberately not routed through `Date`, to avoid timezone-
 * dependent off-by-one-day shifts when formatting an ISO date back out.
 */
export function formatDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${parseInt(d, 10)} ${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
  }
  const human = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (human) {
    const [, d, mon, y] = human;
    const idx = MONTH_LOOKUP[mon.slice(0, 3).toLowerCase()];
    if (idx === undefined) return trimmed;
    return `${parseInt(d, 10)} ${MONTH_NAMES[idx]} ${y}`;
  }
  return trimmed;
}

/** ISO YYYY-MM-DD form of any stored date, for chronological sorting/comparison
 * across the site's two raw date formats (ISO vs "D Month YYYY"). */
export function toComparableIso(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const human = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (!human) return null;
  const [, d, mon, y] = human;
  const idx = MONTH_LOOKUP[mon.slice(0, 3).toLowerCase()];
  if (idx === undefined) return null;
  return `${y}-${String(idx + 1).padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * Whether an event's [startDate, endDate] window covers today (build time,
 * compared as UTC calendar dates) -- used to surface "this Time Trial is
 * live right now" regardless of source, since the stored `status` field is
 * inconsistent (dg-edge sometimes says "live", GT-GridStats-sourced events
 * never set it, historical ones are always long over).
 */
export function isEventActive(e: EventRecord): boolean {
  const startIso = toComparableIso(e.startDate);
  if (!startIso) return false;
  const endIso = toComparableIso(e.endDate) ?? startIso;
  const todayIso = new Date().toISOString().slice(0, 10);
  return todayIso >= startIso && todayIso <= endIso;
}

export function eventDateLabel(e: EventRecord): string {
  if (e.date) return formatDate(e.date) ?? e.date;
  const start = formatDate(e.startDate);
  const end = formatDate(e.endDate);
  if (start && end && start !== end) return `${start} – ${end}`;
  return start || end || 'Date TBD';
}

const WIKI_BASE = 'https://gran-turismo.fandom.com/wiki/';

// A trailing 2-3 letter all-caps group is a tire compound code (SH, RH, RM,
// SM, SS, CM...), not part of the car/class name -- strip it so the wiki
// link targets the actual page title. A parenthetical with digits (a chassis
// code like "(992)" or "(901)") is real car-name content and is kept.
function stripTireCode(name: string): string {
  return name.replace(/\s*\([A-Z]{2,3}\)\s*$/, '').trim();
}

// Some events specify an eligible car *class* ("Gr.3", "Group 1 (RS)") rather
// than one specific car -- these are never going to have their own wiki
// page, so don't bother generating a link for them.
const GENERIC_CLASS_RE = /^(gr\.?|group)\s*\d/i;

export function wikiUrl(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = stripTireCode(name);
  if (!cleaned || GENERIC_CLASS_RE.test(cleaned)) return null;
  return WIKI_BASE + encodeURIComponent(cleaned.replace(/ /g, '_'));
}

/**
 * Best-effort track photo, guessed from GT-GridStats' own asset naming
 * (`/site-assets/TrackPhotos/{Track Name}_.webp`). Confirmed real but not
 * fully reliable -- only ~60% of tracks resolve even with GT-GridStats' own
 * canonical name, and spreadsheet-derived historical events often use a
 * shorter/different name than GT-GridStats' full one, so many won't match at
 * all. Callers should render this with an onerror fallback that hides the
 * image rather than showing a broken-image icon.
 */
export function trackImageUrl(track: string | null | undefined): string | null {
  if (!track) return null;
  return 'https://gt-gridstats.com/site-assets/TrackPhotos/' + encodeURIComponent(`${track}_`) + '.webp';
}

export type StandingRow = { psn: string; displayName: string; points: number; events: number };

export function eventsForSeason(seasonId: string): EventRecord[] {
  return allEvents.filter((e) => e.seasonId === seasonId);
}

export function resultsForSeason(seasonId: string): ResultRow[] {
  const eventIds = new Set(eventsForSeason(seasonId).map((e) => e.id));
  return allResults.filter((r) => eventIds.has(r.eventId));
}

const DROP_WORST_COUNT = 2;

/**
 * Standings for a single season (defaults to the current season). Historical
 * seasons only show players who actually posted a result that season -- the
 * roster of active/tracked players has changed too much over time to
 * meaningfully pre-seed zeroes the way the current season does.
 *
 * Season total = sum of every event's points, EXCLUDING the player's worst-
 * scoring events (matching the crew's original spreadsheet formula:
 * `=SUM(...)-SMALL(...,1)-SMALL(...,2)`). Crucially, an event the player
 * skipped entirely counts as a 0 for this purpose too -- the spreadsheet
 * pads to the season's full event count before dropping the lowest ones, so
 * skipping a small number of events this season is effectively "free," while
 * a near-full-attendance player gets their worst real result(s) forgiven.
 *
 * How many get dropped scales with how far into the season we are (floor(N/3),
 * capped at DROP_WORST_COUNT): full 2-event forgiveness only kicks in once a
 * season has at least 6 events on the books. Every historical season this was
 * validated against already had well over 6, so this doesn't change any of
 * those totals -- it only matters early in a brand new season, where
 * dropping a flat 2 out of e.g. 3 total events so far would throw away most
 * of a perfect scorer's real total (this isn't in the original spreadsheet,
 * which was never evaluated mid-season with that few events on the books).
 */
export function standings(seasonId?: string): StandingRow[] {
  const targetSeasonId = seasonId ?? currentSeason()?.id;
  const results = targetSeasonId ? resultsForSeason(targetSeasonId) : allResults;
  const seasonEventCount = targetSeasonId ? eventsForSeason(targetSeasonId).length : allEvents.length;
  const dropCount = Math.min(DROP_WORST_COUNT, Math.floor(seasonEventCount / 3));

  const pointsByPsn = new Map<string, number[]>();
  const namesByPsn = new Map<string, string>();
  if (targetSeasonId && targetSeasonId === currentSeason()?.id) {
    for (const p of players.filter((p) => p.active)) {
      pointsByPsn.set(p.psn, []);
      namesByPsn.set(p.psn, p.displayName);
    }
  }
  for (const r of results) {
    if (!pointsByPsn.has(r.psn)) {
      pointsByPsn.set(r.psn, []);
      namesByPsn.set(r.psn, playerByPsn(r.psn)?.displayName ?? r.psn);
    }
    pointsByPsn.get(r.psn)!.push(r.points ?? 0);
  }

  const rows: StandingRow[] = [];
  for (const [psn, scores] of pointsByPsn) {
    const padded = [...scores, ...Array(Math.max(0, seasonEventCount - scores.length)).fill(0)];
    padded.sort((a, b) => a - b);
    const kept = padded.slice(Math.min(dropCount, padded.length));
    const points = kept.reduce((sum, p) => sum + p, 0);
    rows.push({ psn, displayName: namesByPsn.get(psn) ?? psn, points, events: scores.length });
  }
  return rows.sort((a, b) => b.points - a.points);
}
