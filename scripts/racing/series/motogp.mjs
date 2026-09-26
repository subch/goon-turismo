// MotoGP (plus Moto2 and Moto3, which ride the same weekends) via the results
// API behind motogp.com. It is the JSON the official site's own results pages
// read -- undocumented but stable for years and widely used by fan projects;
// see robschmitt/MotoGP-API on GitHub for the community write-up. No key, no
// login. Session classifications, event schedule and championship standings
// only: nothing live, no timing feed, no media.
//
// A season is ~22 GPs x 3 classes x ~8 sessions, so a from-scratch sync is a
// few hundred small requests. The runner passes the previous file in and this
// adapter reuses every event already marked complete, so steady state is
// ~30 requests per run (the upcoming events' schedules plus standings).
import { getJson } from '../lib/http.mjs';
import { eventStatus, sessionStatus, result, standingRow, slug } from '../lib/schema.mjs';

const BASE = 'https://api.motogp.pulselive.com/motogp/v1/results';
const DELAY = 350;

export const id = 'motogp';
export const name = 'MotoGP';
export const shortName = 'MotoGP';
export const source = { name: 'motogp.com results', url: 'https://www.motogp.com/en/gp-results' };

// Which of the weekend's classes to keep. Order = display order.
const WANTED = ['MotoGP', 'Moto2', 'Moto3'];

function classIdFor(categoryName) {
  return slug(String(categoryName).replace(/™/g, ''));
}

const SESSION_LABELS = {
  FP: (n) => `FP${n ?? ''}`,
  PR: () => 'Practice',
  Q: (n) => `Q${n ?? ''}`,
  SPR: () => 'Sprint',
  WUP: () => 'Warm Up',
  RAC: () => 'Race',
};
const SESSION_TYPES = { FP: 'practice', PR: 'practice', Q: 'qualifying', SPR: 'sprint', WUP: 'warmup', RAC: 'race' };

function rowFrom(c, type) {
  const timed = type === 'race' || type === 'sprint';
  return result({
    pos: c.position ?? null,
    number: c.rider?.number ?? null,
    name: c.rider?.full_name ?? null,
    team: c.team?.name ?? null,
    make: c.constructor?.name ?? null,
    laps: c.total_laps ?? null,
    time: timed ? c.time ?? null : c.best_lap?.time ?? null,
    gap: c.position === 1 || c.position == null ? null : c.gap?.first ?? null,
    interval: c.position === 1 || c.position == null ? null : c.gap?.prev ?? null,
    bestLap: timed ? c.best_lap?.time ?? null : null,
    points: c.points ?? null,
    // INSTND = "in standings" (classified); OUTSTND = out of the classification
    // (retired, crashed, disqualified -- the API doesn't say which).
    status: c.status === 'INSTND' ? null : c.status === 'OUTSTND' ? 'Not classified' : c.status ?? null,
  });
}

export async function fetchSeason({ season, previous, full, log }) {
  const seasons = await getJson(`${BASE}/seasons`, { delayMs: DELAY });
  const s = seasons.find((x) => x.year === season);
  if (!s) throw new Error(`MotoGP: season ${season} not offered by the API`);

  const rawEvents = (await getJson(`${BASE}/events?seasonUuid=${s.id}`, { delayMs: DELAY }))
    .filter((e) => !e.test)
    .sort((a, b) => String(a.date_start).localeCompare(String(b.date_start)));
  log?.(`MotoGP ${season}: ${rawEvents.length} events`);

  const prevEvents = new Map((previous?.events ?? []).map((e) => [e.id, e]));
  const classes = [];
  const seenClass = new Set();
  const events = [];

  for (const [i, e] of rawEvents.entries()) {
    const eventId = e.short_name.toLowerCase();
    const prev = prevEvents.get(eventId);
    if (prev?.complete && !full) {
      events.push({ ...prev, round: i + 1 });
      for (const sess of prev.sessions) if (!seenClass.has(sess.classId)) seenClass.add(sess.classId);
      continue;
    }

    log?.(`  ${e.short_name} ${e.name}`);
    const cats = (await getJson(`${BASE}/categories?eventUuid=${e.id}`, { delayMs: DELAY }))
      .map((c) => ({ ...c, plain: String(c.name).replace(/™/g, '') }))
      .filter((c) => WANTED.includes(c.plain))
      .sort((a, b) => WANTED.indexOf(a.plain) - WANTED.indexOf(b.plain));

    const sessions = [];
    let allFinishedAndFetched = true;
    for (const cat of cats) {
      const classId = classIdFor(cat.name);
      if (!seenClass.has(classId)) {
        seenClass.add(classId);
        classes.push({ id: classId, name: cat.plain });
      }
      const raw = await getJson(`${BASE}/sessions?eventUuid=${e.id}&categoryUuid=${cat.id}`, { delayMs: DELAY });
      for (const rs of raw) {
        const type = SESSION_TYPES[rs.type] ?? 'other';
        const label = (SESSION_LABELS[rs.type] ?? (() => rs.type))(rs.number);
        const prevSession = prev?.sessions?.find((ps) => ps.id === rs.id);
        let results = full ? null : prevSession?.results ?? null;
        if (rs.status === 'FINISHED' && !results) {
          const cls = await getJson(`${BASE}/session/${rs.id}/classification?test=false`, { delayMs: DELAY });
          results = (cls.classification ?? []).map((c) => rowFrom(c, type));
          if (!results.length) results = null;
        }
        if (rs.status !== 'FINISHED' || !results) allFinishedAndFetched = false;
        sessions.push({
          id: rs.id,
          classId,
          type,
          name: label,
          startUtc: rs.date ?? null,
          endUtc: null,
          status: sessionStatus(rs.date, null, rs.status, !!results),
          results,
        });
      }
    }
    if (!cats.length || !sessions.length) allFinishedAndFetched = false;

    const status = eventStatus(e.date_start, e.date_end, e.status);
    events.push({
      id: eventId,
      round: i + 1,
      name: e.name.replace(/\b(\w)(\w*)/g, (_, a, b) => a + b.toLowerCase()).replace(/\bOf\b/g, 'of').replace(/\bThe\b/g, 'the').replace(/\bDe\b/g, 'de'),
      shortName: e.short_name,
      circuit: e.circuit?.name ?? null,
      location: e.circuit?.place ?? null,
      country: e.country?.name ?? null,
      dateStart: e.date_start,
      dateEnd: e.date_end,
      status,
      officialUrl: `https://www.motogp.com/en/gp-results/${season}/${e.short_name.toLowerCase()}/motogp/rac/classification`,
      complete: status === 'finished' && e.status === 'FINISHED' && allFinishedAndFetched,
      sessions,
    });
  }

  // Classes may all have come from reused events; rebuild the list in WANTED order.
  const classList = WANTED.map((n) => ({ id: slug(n), name: n })).filter((c) => seenClass.has(c.id));

  log?.(`MotoGP ${season}: standings`);
  const standings = [];
  // Category uuids are stable across events; take them from the first event that has them.
  const firstEvent = rawEvents[0];
  const cats = firstEvent
    ? (await getJson(`${BASE}/categories?eventUuid=${firstEvent.id}`, { delayMs: DELAY }))
        .map((c) => ({ ...c, plain: String(c.name).replace(/™/g, '') }))
        .filter((c) => WANTED.includes(c.plain))
    : [];
  for (const cat of cats) {
    const st = await getJson(`${BASE}/standings?seasonUuid=${s.id}&categoryUuid=${cat.id}`, { delayMs: DELAY });
    standings.push({
      classId: classIdFor(cat.name),
      type: 'riders',
      name: `${cat.plain} Riders' Championship`,
      rows: (st.classification ?? []).map((r) =>
        standingRow({
          pos: r.position ?? null,
          name: r.rider?.full_name ?? null,
          number: r.rider?.number ?? null,
          team: r.team?.name ?? null,
          make: r.constructor?.name ?? null,
          points: r.points ?? null,
          wins: r.race_wins ?? null,
        }),
      ),
    });
  }

  return { classes: classList.length ? classList : classes, events, standings };
}
