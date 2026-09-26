// Loader and helpers for the real-world racing pages (/racing/). Reads the
// per-series season files the sync writes under data/racing/, whose shape is
// documented in scripts/racing/lib/schema.mjs. Everything here is pure and
// runs at build time; the only client-side code on these pages is the
// local-timezone formatting in components/racing/LocalTime.astro.

export type EventStatus = 'finished' | 'live' | 'upcoming' | 'cancelled';
export type SessionType = 'practice' | 'qualifying' | 'sprint' | 'race' | 'warmup' | 'other';

export type RacingResult = {
  pos: number | null;
  number: string | number | null;
  name: string | null;
  team: string | null;
  make: string | null;
  cls?: string | null;
  laps: string | number | null;
  time: string | null;
  gap: string | null;
  interval: string | null;
  bestLap: string | null;
  points: number | null;
  status: string | null;
};

export type RacingSession = {
  id: string;
  classId: string;
  type: SessionType;
  name: string;
  startUtc: string | null;
  endUtc: string | null;
  status: EventStatus;
  results: RacingResult[] | null;
};

export type RacingEvent = {
  id: string;
  round: number | null;
  name: string;
  shortName: string;
  circuit: string | null;
  location: string | null;
  country: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  status: EventStatus;
  officialUrl: string | null;
  complete: boolean;
  test?: boolean;
  /** A playoff / post-season round (NASCAR's Chase for the Cup). */
  playoff?: boolean;
  sessions: RacingSession[];
};

export type StandingRow = {
  pos: number | null;
  name: string | null;
  number: string | number | null;
  team: string | null;
  make: string | null;
  points: number | null;
  wins: number | null;
  /** Series-specific columns, rendered after Wins in insertion order (NASCAR playoff points, stage points...). */
  extra?: Record<string, string | number | null>;
};

export type Standing = {
  classId: string;
  type: 'drivers' | 'riders' | 'teams' | 'constructors' | 'manufacturers';
  name: string;
  rows: StandingRow[];
};

export type SeriesTier = 'main' | 'other';

export type SeasonFile = {
  series: string;
  name: string;
  shortName: string;
  tier?: SeriesTier;
  season: number;
  /** How the series itself names the season when it isn't a calendar year ("2025-26" for Formula E). */
  seasonLabel?: string;
  syncedAt: string;
  source: { name: string; url: string };
  classes: { id: string; name: string }[];
  events: RacingEvent[];
  standings: Standing[];
};

const modules = import.meta.glob<{ default: SeasonFile }>('../../data/racing/*/*.json', { eager: true });

export const racingSeasons: SeasonFile[] = Object.values(modules)
  .map((m) => m.default)
  .filter(Boolean)
  .sort((a, b) => a.series.localeCompare(b.series) || b.season - a.season);

// Display order on /racing/: the three the crew follows closest first, then
// the rest. Mirrors the registration order in scripts/racing/series/index.mjs.
const SERIES_ORDER = ['motogp', 'wec', 'f1', 'wsbk', 'wrc', 'motoamerica', 'nascar', 'formulae', 'indycar'];

export type SeriesSummary = { id: string; name: string; shortName: string; tier: SeriesTier; seasons: number[]; latest: SeasonFile };

export function seriesList(): SeriesSummary[] {
  const byId = new Map<string, SeasonFile[]>();
  for (const f of racingSeasons) {
    if (!byId.has(f.series)) byId.set(f.series, []);
    byId.get(f.series)!.push(f);
  }
  return [...byId.entries()]
    .map(([id, files]) => {
      files.sort((a, b) => b.season - a.season);
      return {
        id,
        name: files[0].name,
        shortName: files[0].shortName,
        tier: files[0].tier ?? 'other',
        seasons: files.map((f) => f.season),
        latest: files[0],
      };
    })
    .sort((a, b) => {
      const ia = SERIES_ORDER.indexOf(a.id);
      const ib = SERIES_ORDER.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
    });
}

export function seasonFile(series: string, season: number): SeasonFile | undefined {
  return racingSeasons.find((f) => f.series === series && f.season === season);
}

export function className(file: SeasonFile, classId: string): string {
  return file.classes.find((c) => c.id === classId)?.name ?? classId;
}

/** Real rounds only -- tests/prologues are kept in the data but not counted. */
export function rounds(file: SeasonFile): RacingEvent[] {
  return file.events.filter((e) => !e.test);
}

export function eventByIdIn(file: SeasonFile, id: string): RacingEvent | undefined {
  return file.events.find((e) => e.id === id);
}

/** The next session that hasn't started yet, across the whole season. */
export function nextSession(file: SeasonFile, now = Date.now()): { event: RacingEvent; session: RacingSession } | null {
  let best: { event: RacingEvent; session: RacingSession } | null = null;
  for (const event of file.events) {
    if (event.status === 'cancelled') continue;
    for (const session of event.sessions) {
      if (!session.startUtc) continue;
      const t = Date.parse(session.startUtc);
      if (Number.isNaN(t) || t < now) continue;
      if (!best || t < Date.parse(best.session.startUtc!)) best = { event, session };
    }
  }
  return best;
}

/** The event happening now, else the next one on the calendar. */
export function currentOrNextEvent(file: SeasonFile): RacingEvent | null {
  const live = file.events.find((e) => e.status === 'live');
  if (live) return live;
  return file.events.find((e) => e.status === 'upcoming') ?? null;
}

export function lastFinishedEvent(file: SeasonFile): RacingEvent | null {
  const done = file.events.filter((e) => e.status === 'finished' && e.sessions.some((s) => s.results));
  return done.length ? done[done.length - 1] : null;
}

/** Winner of the main race in each class of an event, for one-line summaries. */
export function raceWinners(file: SeasonFile, event: RacingEvent): { classId: string; className: string; session: RacingSession; winner: RacingResult }[] {
  const out: { classId: string; className: string; session: RacingSession; winner: RacingResult }[] = [];
  for (const cls of file.classes) {
    const races = event.sessions.filter((s) => s.classId === cls.id && s.type === 'race' && s.results?.length);
    const main = races[races.length - 1];
    const winner = main?.results?.find((r) => r.pos === 1) ?? main?.results?.[0];
    if (main && winner) out.push({ classId: cls.id, className: cls.name, session: main, winner });
  }
  return out;
}

export function resultLabel(r: RacingResult | StandingRow): string {
  if (r.name) return r.name;
  const parts = [r.number != null ? `#${String(r.number).replace(/^#/, '')}` : null, r.team ?? r.make ?? null].filter(Boolean);
  return parts.join(' ') || '—';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtYmd(ymd: string, withYear: boolean): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

/** "25 – 27 Sep 2026", "30 May – 1 Jun 2026", "14 Apr 2026". */
export function eventDates(e: RacingEvent, withYear = true): string {
  if (!e.dateStart) return 'Date TBD';
  const end = e.dateEnd ?? e.dateStart;
  if (end === e.dateStart) return fmtYmd(e.dateStart, withYear);
  const [ys, ms, ds] = e.dateStart.split('-');
  const [ye, me] = end.split('-');
  if (ys === ye && ms === me) return `${Number(ds)} – ${fmtYmd(end, withYear)}`;
  return `${fmtYmd(e.dateStart, false)} – ${fmtYmd(end, withYear)}`;
}

/** Server-side fallback for a session time, in UTC; LocalTime.astro swaps it
 * for the viewer's zone once JS runs. */
export function utcLabel(iso: string | null): string {
  if (!iso) return 'time TBD';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'time TBD';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hh}:${mm} UTC`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export const SESSION_TYPE_LABEL: Record<SessionType, string> = {
  practice: 'Practice',
  qualifying: 'Qualifying',
  sprint: 'Sprint',
  race: 'Race',
  warmup: 'Warm up',
  other: 'Session',
};
