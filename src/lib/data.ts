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

export function eventDateLabel(e: EventRecord): string {
  if (e.date) return e.date;
  if (e.startDate && e.endDate && e.startDate !== e.endDate) return `${e.startDate} – ${e.endDate}`;
  return e.startDate || e.endDate || 'Date TBD';
}

const WIKI_BASE = 'https://gran-turismo.fandom.com/wiki/';

// A trailing 2-3 letter all-caps group is a tire compound code (SH, RH, RM,
// SM, SS, CM...), not part of the car/class name -- strip it so the wiki
// link targets the actual page title. A parenthetical with digits (a chassis
// code like "(992)" or "(901)") is real car-name content and is kept.
function stripTireCode(name: string): string {
  return name.replace(/\s*\([A-Z]{2,3}\)\s*$/, '').trim();
}

export function wikiUrl(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = stripTireCode(name);
  if (!cleaned) return null;
  return WIKI_BASE + encodeURIComponent(cleaned.replace(/ /g, '_'));
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
 * Season total = sum of every event's points, EXCLUDING the player's 2
 * lowest-scoring events (matching the crew's original spreadsheet formula:
 * `=SUM(...)-SMALL(...,1)-SMALL(...,2)`). Crucially, an event the player
 * skipped entirely counts as a 0 for this purpose too -- the spreadsheet
 * pads to the season's full event count before dropping the two lowest, so
 * skipping fewer than 2 events this season is effectively "free," while a
 * near-full-attendance player gets their worst 1-2 *real* results forgiven.
 */
export function standings(seasonId?: string): StandingRow[] {
  const targetSeasonId = seasonId ?? currentSeason()?.id;
  const results = targetSeasonId ? resultsForSeason(targetSeasonId) : allResults;
  const seasonEventCount = targetSeasonId ? eventsForSeason(targetSeasonId).length : allEvents.length;

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
    const kept = padded.slice(Math.min(DROP_WORST_COUNT, padded.length));
    const points = kept.reduce((sum, p) => sum + p, 0);
    rows.push({ psn, displayName: namesByPsn.get(psn) ?? psn, points, events: scores.length });
  }
  return rows.sort((a, b) => b.points - a.points);
}
