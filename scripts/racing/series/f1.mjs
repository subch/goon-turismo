// Formula 1 via Jolpica (https://api.jolpi.ca), the community-run successor to
// the Ergast API. Open data, documented, rate-limited to 500 requests/hour
// unauthenticated -- a full season sync is ~15 requests, so a 2-hourly cron is
// nowhere near it. Jolpica carries race, sprint and qualifying classifications
// plus standings; it does NOT carry free-practice times, so those sessions
// show on the schedule with results left null.
//
// Jolpica's own terms: free to use with attribution, which the racing pages'
// footer gives. No F1/FOM live-timing data is touched anywhere here.
import { getJson } from '../lib/http.mjs';
import { classifySession, eventStatus, sessionStatus, result, standingRow } from '../lib/schema.mjs';

const BASE = 'https://api.jolpi.ca/ergast/f1';
const PAGE = 100;
const DELAY = 600; // ms between requests; well inside the burst limit

export const id = 'f1';
export const name = 'Formula 1';
export const shortName = 'F1';
export const source = { name: 'Jolpica F1 API (Ergast successor)', url: 'https://api.jolpi.ca/' };
export const classes = [{ id: 'f1', name: 'Formula 1' }];

/** Walk a paginated Jolpica table and return every Race entry, merged by round. */
async function fetchAllRaces(path, log) {
  const byRound = new Map();
  for (let offset = 0; ; offset += PAGE) {
    const json = await getJson(`${BASE}/${path}.json?limit=${PAGE}&offset=${offset}`, { delayMs: DELAY });
    const md = json.MRData;
    const races = md.RaceTable?.Races ?? [];
    for (const r of races) {
      const key = r.round;
      if (!byRound.has(key)) byRound.set(key, { ...r });
      else {
        // Pagination can split one race's rows across two pages.
        const acc = byRound.get(key);
        for (const k of ['Results', 'SprintResults', 'QualifyingResults']) {
          if (r[k]) acc[k] = [...(acc[k] ?? []), ...r[k]];
        }
      }
    }
    const total = Number(md.total ?? 0);
    if (offset + PAGE >= total || races.length === 0) break;
  }
  log?.(`  ${path}: ${byRound.size} rounds`);
  return byRound;
}

function iso(date, time) {
  if (!date) return null;
  return time ? `${date}T${time}` : `${date}T00:00:00Z`;
}

function driverName(d) {
  return `${d.givenName} ${d.familyName}`;
}

function raceRow(r) {
  return result({
    pos: Number(r.position) || null,
    number: r.number ?? null,
    name: driverName(r.Driver),
    team: r.Constructor?.name ?? null,
    laps: r.laps ?? null,
    // Jolpica's Time is the winner's race time on row 1 and "+5.543" behind
    // the winner on every other row -- split it into the two fields it is.
    time: r.position === '1' ? r.Time?.time ?? null : null,
    gap: r.position === '1' ? null : r.Time?.time ?? null,
    bestLap: r.FastestLap?.Time?.time ?? null,
    points: r.points != null ? Number(r.points) : null,
    status: r.status ?? null,
  });
}

function qualiRow(r) {
  const best = r.Q3 || r.Q2 || r.Q1 || null;
  const segment = r.Q3 ? 'Q3' : r.Q2 ? 'Q2' : r.Q1 ? 'Q1' : null;
  return result({
    pos: Number(r.position) || null,
    number: r.number ?? null,
    name: driverName(r.Driver),
    team: r.Constructor?.name ?? null,
    time: best,
    bestLap: r.Q1 ? [r.Q1, r.Q2, r.Q3].filter(Boolean).join(' / ') : null,
    status: segment,
  });
}

export async function fetchSeason({ season, log }) {
  log?.(`F1 ${season}: schedule`);
  const schedule = await fetchAllRaces(`${season}`, log);
  const results = await fetchAllRaces(`${season}/results`, log);
  const sprints = await fetchAllRaces(`${season}/sprint`, log);
  const qualis = await fetchAllRaces(`${season}/qualifying`, log);

  const events = [];
  for (const race of [...schedule.values()].sort((a, b) => Number(a.round) - Number(b.round))) {
    const round = Number(race.round);
    const raceDate = race.date;
    const dateStart = race.FirstPractice?.date ?? race.SprintQualifying?.date ?? raceDate;
    const sessions = [];
    const push = (key, label, type, rows) => {
      const s = race[key];
      const start = key === 'race' ? iso(race.date, race.time) : s ? iso(s.date, s.time) : null;
      if (!start && !rows) return;
      sessions.push({
        id: `${round}-${key.toLowerCase()}`,
        classId: 'f1',
        type,
        name: label,
        startUtc: start,
        endUtc: null,
        status: sessionStatus(start, null, null, !!rows?.length),
        results: rows ?? null,
      });
    };
    const q = qualis.get(race.round)?.QualifyingResults?.map(qualiRow);
    const sp = sprints.get(race.round)?.SprintResults?.map(raceRow);
    const rr = results.get(race.round)?.Results?.map(raceRow);
    push('FirstPractice', 'FP1', 'practice');
    if (race.SprintQualifying) {
      push('SprintQualifying', 'Sprint Qualifying', 'qualifying');
      push('Sprint', 'Sprint', 'sprint', sp);
    } else {
      push('SecondPractice', 'FP2', 'practice');
      push('ThirdPractice', 'FP3', 'practice');
    }
    push('Qualifying', 'Qualifying', 'qualifying', q);
    push('race', 'Grand Prix', 'race', rr);
    sessions.sort((a, b) => String(a.startUtc).localeCompare(String(b.startUtc)));

    const status = eventStatus(dateStart, raceDate);
    events.push({
      id: race.Circuit.circuitId,
      round,
      name: race.raceName,
      shortName: race.raceName.replace(/ Grand Prix$/, ''),
      circuit: race.Circuit.circuitName,
      location: race.Circuit.Location?.locality ?? null,
      country: race.Circuit.Location?.country ?? null,
      dateStart,
      dateEnd: raceDate,
      status,
      officialUrl: race.url ?? null, // Jolpica links the Wikipedia article; F1's own results pages need a per-race slug we can't derive
      complete: status === 'finished' && !!rr?.length,
      sessions,
    });
  }

  log?.(`F1 ${season}: standings`);
  const ds = await getJson(`${BASE}/${season}/driverstandings.json?limit=${PAGE}`, { delayMs: DELAY });
  const cs = await getJson(`${BASE}/${season}/constructorstandings.json?limit=${PAGE}`, { delayMs: DELAY });
  const standings = [
    {
      classId: 'f1',
      type: 'drivers',
      name: "Drivers' Championship",
      rows: (ds.MRData.StandingsTable.StandingsLists?.[0]?.DriverStandings ?? []).map((r) =>
        standingRow({
          pos: Number(r.position) || null,
          name: driverName(r.Driver),
          number: r.Driver.permanentNumber ?? null,
          team: r.Constructors?.map((c) => c.name).join(' / ') || null,
          points: Number(r.points),
          wins: Number(r.wins),
        }),
      ),
    },
    {
      classId: 'f1',
      type: 'constructors',
      name: "Constructors' Championship",
      rows: (cs.MRData.StandingsTable.StandingsLists?.[0]?.ConstructorStandings ?? []).map((r) =>
        standingRow({ pos: Number(r.position) || null, name: r.Constructor.name, points: Number(r.points), wins: Number(r.wins) }),
      ),
    },
  ];

  return { classes, events, standings };
}
