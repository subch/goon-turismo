// NASCAR Cup Series via the public JSON feeds on cf.nascar.com that
// nascar.com's own schedule, results and standings pages read (the "cacher"
// feeds; widely used by fan projects, no key). Cup only (series_id 1).
//
//   /cacher/<year>/race_list_basic.json          every race of every series
//   /cacher/<year>/1/<race_id>/weekend-feed.json race results + qualifying
//   /cacher/<year>/1/points-feed.json            driver standings
//
// Times in the race list are US Eastern wall-clock with no zone marker;
// they are converted to UTC here so the page can show them in the viewer's
// own zone. Some race folders answer 403 until the weekend starts -- treated
// as "not published yet".
import { getJson } from '../lib/http.mjs';
import { eventStatus, sessionStatus, result, standingRow } from '../lib/schema.mjs';

const BASE = 'https://cf.nascar.com/cacher';
const DELAY = 350;
const SERIES_ID = 1;

export const id = 'nascar';
export const name = 'NASCAR Cup Series';
export const shortName = 'NASCAR';
export const tier = 'other';
export const source = { name: 'nascar.com results', url: 'https://www.nascar.com/results/' };
export const classes = [{ id: 'cup', name: 'Cup Series' }];

// Eastern wall-clock "2026-09-19T19:30:00" -> UTC ISO, DST-aware.
function easternToUtc(local) {
  if (!local) return null;
  const naive = new Date(`${local}Z`);
  if (Number.isNaN(naive.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(naive);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offset = asIfUtc - naive.getTime(); // what New York shows minus UTC = zone offset
  return new Date(naive.getTime() - offset).toISOString();
}

function raceRow(r, winnerLaps) {
  const finished = /running/i.test(r.finishing_status ?? '');
  let gap = null;
  if (r.finishing_position > 1) {
    if (r.diff_laps > 0) gap = `-${r.diff_laps} lap${r.diff_laps > 1 ? 's' : ''}`;
    else if (r.diff_time > 0) gap = `+${Number(r.diff_time).toFixed(3)}`;
    else if (winnerLaps && r.laps_completed < winnerLaps) gap = `-${winnerLaps - r.laps_completed} laps`;
  }
  return result({
    pos: r.finishing_position || null,
    number: r.car_number ?? null,
    name: r.driver_fullname ?? null,
    team: r.team_name ?? null,
    make: r.car_make ?? null,
    laps: r.laps_completed ?? null,
    gap,
    points: r.points_earned ?? null,
    status: finished ? null : r.finishing_status ?? null,
  });
}

function qualiRow(r) {
  return result({
    pos: r.finishing_position || r.position || null,
    number: r.car_number ?? r.vehicle_number ?? null,
    name: r.driver_fullname ?? r.driver_name ?? null,
    team: r.team_name ?? null,
    make: r.car_make ?? r.manufacturer ?? null,
    // Some weekends' qualifying runs carry positions only (every time is 0).
    time: r.best_lap_time > 0 ? String(r.best_lap_time) : null,
    bestLap: r.best_lap_speed > 0 ? `${r.best_lap_speed} mph` : null,
  });
}

export async function fetchSeason({ season, previous, full, log }) {
  const list = await getJson(`${BASE}/${season}/race_list_basic.json`, { delayMs: DELAY });
  const races = (list[`series_${SERIES_ID}`] ?? []).sort((a, b) => String(a.race_date).localeCompare(String(b.race_date)));
  if (!races.length) throw new Error(`NASCAR: no Cup races listed for ${season}`);
  log?.(`NASCAR ${season}: ${races.length} Cup races`);

  const prevEvents = new Map((previous?.events ?? []).map((e) => [e.id, e]));
  const events = [];
  let round = 0;
  for (const r of races) {
    const eventId = String(r.race_id);
    // race_type_id 1 = points race; 2 = exhibition (Clash, Duels, All-Star),
    // which stay on file but outside the round numbering.
    const exhibition = r.race_type_id !== 1;
    if (!exhibition) round += 1;
    const prev = prevEvents.get(eventId);
    if (prev?.complete && !full) {
      events.push({ ...prev, round: exhibition ? null : round, test: exhibition || undefined });
      continue;
    }
    const raceDate = String(r.race_date).slice(0, 10);
    const qualDate = r.qualifying_date && !/T00:00:00$/.test(r.qualifying_date) ? String(r.qualifying_date).slice(0, 10) : null;
    const dateStart = qualDate && qualDate < raceDate ? qualDate : raceDate;
    const status = eventStatus(dateStart, raceDate);
    const raceStart = easternToUtc(r.race_date);

    const sessions = [];
    let raceResults = null;
    if (status !== 'upcoming' || (raceStart && Date.parse(raceStart) - Date.now() < 3 * 86400e3)) {
      log?.(`  ${r.race_name} (${r.track_name})`);
      let feed = null;
      try {
        feed = await getJson(`${BASE}/${season}/${SERIES_ID}/${r.race_id}/weekend-feed.json`, { delayMs: DELAY, retries: 0 });
      } catch (err) {
        if (!/HTTP 40[34]/.test(err.message)) throw err;
      }
      const wr = feed?.weekend_race?.[0];
      const rows = (wr?.results ?? []).filter((x) => x.finishing_position > 0).sort((a, b) => a.finishing_position - b.finishing_position);
      if (rows.length) raceResults = rows.map((x) => raceRow(x, rows[0]?.laps_completed));
      for (const run of feed?.weekend_runs ?? []) {
        const rr = (run.results ?? []).filter((x) => (x.finishing_position ?? x.position) > 0);
        if (!rr.length) continue;
        const isQual = /qual/i.test(run.run_name ?? '') || run.run_type === 2;
        sessions.push({
          id: `${eventId}-run-${run.run_id ?? run.timing_run_id ?? sessions.length}`,
          classId: 'cup',
          type: isQual ? 'qualifying' : 'practice',
          name: String(run.run_name ?? (isQual ? 'Qualifying' : 'Practice')).replace(/^.*?(Practice|Qualifying)/, '$1').trim() || run.run_name,
          startUtc: easternToUtc(run.start_time ?? run.start_time_utc) ?? (qualDate ? easternToUtc(`${qualDate}T00:00:00`) : null),
          endUtc: null,
          status: 'finished',
          results: rr.sort((a, b) => (a.finishing_position ?? a.position) - (b.finishing_position ?? b.position)).map(qualiRow),
        });
      }
    }
    sessions.push({
      id: `${eventId}-race`,
      classId: 'cup',
      type: 'race',
      name: r.race_name,
      startUtc: raceStart,
      endUtc: null,
      status: sessionStatus(raceStart, null, null, !!raceResults),
      results: raceResults,
    });
    events.push({
      id: eventId,
      round: exhibition ? null : round,
      test: exhibition || undefined,
      name: r.race_name,
      shortName: r.track_name,
      circuit: r.track_name,
      location: null,
      country: 'USA',
      dateStart,
      dateEnd: raceDate,
      status,
      officialUrl: 'https://www.nascar.com/results/',
      complete: status === 'finished' && !!raceResults,
      playoff: r.playoff_round > 0 || undefined,
      sessions,
    });
  }

  log?.(`NASCAR ${season}: standings`);
  let standings = [];
  try {
    const pts = await getJson(`${BASE}/${season}/${SERIES_ID}/points-feed.json`, { delayMs: DELAY });
    const all = (Array.isArray(pts) ? pts : pts.points ?? []).sort((a, b) => a.position - b.position);
    const row = (p, extra) =>
      standingRow({
        pos: p.position ?? null,
        name: p.driver_name ?? null,
        number: p.car_no ?? p.car_number ?? null,
        make: p.manufacturer ?? null,
        points: p.points ?? null,
        wins: p.wins ?? null,
        extra,
      });
    // The playoff field: everyone the feed has seeded (playoff_rank > 0),
    // which is the 16 whose points were reset at the start of the Chase.
    // The feed's own figures are shown as they are -- playoff points, stage
    // points, seed, gap to the leader -- rather than a cutline we would have
    // to infer from a format that changes year to year.
    const playoff = all.filter((p) => p.playoff_rank > 0);
    if (playoff.length) {
      standings.push({
        classId: 'cup',
        type: 'drivers',
        name: 'Playoff standings (Chase for the Cup)',
        rows: playoff.map((p, i) =>
          row(
            { ...p, position: i + 1 },
            {
              'To leader': p.delta_leader ? String(p.delta_leader) : '—',
              'Playoff pts': p.playoff_points ?? 0,
              'Stage pts': p.stage_points ?? 0,
              Seed: p.playoff_rank,
              'Playoff wins': p.playoff_race_wins ?? 0,
              Clinched: p.is_clinch ? 'yes' : '',
            },
          ),
        ),
      });
    }
    standings.push({
      classId: 'cup',
      type: 'drivers',
      name: playoff.length ? 'Season points (all drivers)' : "Drivers' Championship",
      rows: all.map((p) =>
        row(p, {
          'Stage pts': p.stage_points ?? 0,
          'Playoff pts': p.playoff_points ?? 0,
          Poles: p.poles ?? 0,
          'Top 5': p.top_5 ?? 0,
          'Top 10': p.top_10 ?? 0,
          'Laps led': p.laps_led ?? 0,
          DNF: p.dnf ?? 0,
        }),
      ),
    });
  } catch (err) {
    log?.(`  standings unavailable: ${err.message}`);
  }

  return { classes, events, standings };
}
