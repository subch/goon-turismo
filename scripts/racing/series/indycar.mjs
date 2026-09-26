// NTT IndyCar Series via the JSON API behind indycar.com's own Results and
// Standings pages (www.indycar.com/api/results/...; same-origin, no key).
//
//   SeasonDropDown?id=<series>          every year -> events -> sessions (ids + names)
//   EventsSessionDetails?id=<session>   one session's classification + its date/type
//   YearPointSummary?year=&id=<series>  the points table with per-race breakdown
//
// <series> is the NTT IndyCar Series GUID the site uses. Every session the
// site lists (practices, the qualifying rounds, the race) is fetched once
// and kept; times are the session's date only, since the feed has no start
// time.
import { getJson } from '../lib/http.mjs';
import { eventStatus, sessionStatus, result, standingRow, slug } from '../lib/schema.mjs';

const BASE = 'https://www.indycar.com/api/results';
const SERIES_GUID = 'b856a4f1-e85c-4fac-8c36-fd58d962227a';
const DELAY = 400;
const HEADERS = { 'X-Requested-With': 'XMLHttpRequest' };

export const id = 'indycar';
export const name = 'IndyCar Series';
export const shortName = 'IndyCar';
export const tier = 'other';
export const source = { name: 'indycar.com results', url: 'https://www.indycar.com/Results' };
export const classes = [{ id: 'indycar', name: 'IndyCar' }];

function sessionType(name) {
  const s = String(name).toLowerCase();
  if (/race/.test(s) && !/practice/.test(s)) return 'race';
  if (/qualif|fast 6|fast 12|pole/.test(s)) return 'qualifying';
  if (/warm/.test(s)) return 'warmup';
  if (/practice/.test(s)) return 'practice';
  return 'other';
}

// "9/6/2026" -> 2026-09-06
function usDate(s) {
  const m = String(s ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

function row(r, type) {
  const timed = type === 'race';
  const laps = r.LapsComplete ?? null;
  let gap = null;
  if (r.PositionFinish > 1) {
    if (r.LapsDown > 0) gap = `-${r.LapsDown} lap${r.LapsDown > 1 ? 's' : ''}`;
    else if (r.Difference && !/^-+\.?-*$/.test(r.Difference)) gap = `+${String(r.Difference).replace(/^\+/, '')}`;
  }
  return result({
    pos: r.PositionFinish || null,
    number: r.CarNumber ?? null,
    name: r.DriverName ?? `${r.FirstName ?? ''} ${r.LastName ?? ''}`.trim(),
    team: r.TeamName ?? null,
    laps,
    time: timed ? r.ElapsedTime ?? null : r.BestLapTime ?? null,
    gap: timed ? gap : r.PositionFinish > 1 && r.Difference && !/^-+\.?-*$/.test(r.Difference) ? `+${String(r.Difference).replace(/^\+/, '')}` : null,
    bestLap: timed ? r.BestLapTime ?? null : null,
    points: timed && r.PointsEarned != null ? r.PointsEarned : null,
    status: r.Status && !/^running$/i.test(r.Status) ? r.Status : null,
  });
}

export async function fetchSeason({ season, previous, full, log }) {
  const dropdown = await getJson(`${BASE}/SeasonDropDown?id=${SERIES_GUID}`, { delayMs: DELAY, headers: HEADERS });
  const year = dropdown.find((y) => String(y.Year) === String(season));
  if (!year?.Events?.length) throw new Error(`IndyCar: no events for ${season} in the season dropdown`);
  // The dropdown lists newest first; the race session id order (a
  // per-season sequence) gives the calendar order.
  const events = [];
  const prevEvents = new Map((previous?.events ?? []).map((e) => [e.id, e]));
  const list = [...year.Events].map((e) => {
    const race = (e.Sessions ?? []).find((s) => /^race$/i.test(s.SessionName)) ?? e.Sessions?.[0];
    return { ...e, raceId: Number(race?.EventsSessionID ?? 0) };
  });
  log?.(`IndyCar ${season}: ${list.length} events`);

  for (const e of list) {
    const eventId = slug(e.EventName);
    const prev = prevEvents.get(eventId);
    if (prev?.complete && !full) {
      events.push(prev);
      continue;
    }
    log?.(`  ${e.EventName}`);
    const sessions = [];
    const dates = new Set();
    let allDone = true;
    // Sessions are listed newest first; reverse for chronological order.
    for (const s of [...(e.Sessions ?? [])].reverse()) {
      const type = sessionType(s.SessionName);
      const sessionId = `${eventId}-${s.EventsSessionID}`;
      const prevSession = prev?.sessions?.find((p) => p.id === sessionId);
      let results = full ? null : prevSession?.results ?? null;
      let date = prevSession?.startUtc?.slice(0, 10) ?? null;
      if (!results) {
        const detail = await getJson(`${BASE}/EventsSessionDetails?id=${s.EventsSessionID}`, { delayMs: DELAY, headers: HEADERS });
        date = usDate(detail.SessionDate) ?? date;
        const records = (detail.records ?? []).filter((r) => !r.IsDeleted);
        if (records.length) results = records.sort((a, b) => (a.PositionFinish || 999) - (b.PositionFinish || 999)).map((r) => row(r, type));
      }
      if (date) dates.add(date);
      if (!results) allDone = false;
      sessions.push({
        id: sessionId,
        classId: 'indycar',
        type,
        name: s.SessionName,
        startUtc: date ? `${date}T00:00:00Z` : null,
        endUtc: null,
        status: sessionStatus(null, null, results ? 'FINISHED' : null, !!results),
        results,
      });
    }
    const sorted = [...dates].sort();
    const dateStart = sorted[0] ?? null;
    const dateEnd = sorted[sorted.length - 1] ?? dateStart;
    const status = dateStart ? eventStatus(dateStart, dateEnd) : 'upcoming';
    for (const s of sessions) if (!s.results && status === 'finished') s.status = 'finished';
    events.push({
      id: eventId,
      round: 0,
      name: e.EventName,
      shortName: e.EventName.replace(/^.*?(Grand Prix of|at)\s+/i, '').replace(/\s+\d+$/, ''),
      circuit: null,
      location: null,
      country: null,
      dateStart,
      dateEnd,
      status,
      officialUrl: `https://www.indycar.com/results/ntt-indycar-series/${season}/${slug(e.EventName)}/race`,
      complete: status === 'finished' && sessions.length > 0 && allDone,
      raceId: e.raceId,
      sessions,
    });
  }
  events.sort((a, b) => String(a.dateStart ?? '9').localeCompare(String(b.dateStart ?? '9')) || a.raceId - b.raceId);
  events.forEach((ev, i) => {
    ev.round = i + 1;
    delete ev.raceId;
  });

  log?.(`IndyCar ${season}: standings`);
  const pts = await getJson(`${BASE}/YearPointSummary?year=${season}&id=${SERIES_GUID}`, { delayMs: DELAY, headers: HEADERS });
  const standings = [
    {
      classId: 'indycar',
      type: 'drivers',
      name: "Drivers' Championship",
      rows: (pts.DriverList ?? [])
        .sort((a, b) => a.OverallPosition - b.OverallPosition)
        .map((d) =>
          standingRow({
            pos: d.OverallPosition ?? null,
            name: d.DriverName ?? null,
            points: d.TotalPoints ?? null,
            wins: d.TotalWins ?? null,
            extra: { Poles: d.TotalPoles ?? 0, 'Top 5': d.TotalTop5s ?? 0, 'Oval pts': d.OvalPoints ?? 0, 'Road pts': d.RoadPoints ?? 0 },
          }),
        ),
    },
  ];

  return { classes, events, standings };
}
