// WorldSBK (plus WorldSSP) via the sport-data API behind worldsbk.com --
// api.pulselive.worldsbk.com, the same JSON the site's own Results and
// Standings pages fetch (endpoint paths taken from the site's results.js).
// No key, no login; JSON:API shaped, with riders/teams sideloaded under
// `included`. Session classifications, round schedule and standings only.
//
// Same incremental strategy as MotoGP: rounds already marked complete in the
// previous file are reused untouched, so a steady-state sync is a handful of
// requests.
import { getJson } from '../lib/http.mjs';
import { eventStatus, sessionStatus, result, standingRow, formatMs } from '../lib/schema.mjs';

const BASE = 'https://api.pulselive.worldsbk.com';
const DELAY = 350;

export const id = 'wsbk';
export const name = 'World Superbike';
export const shortName = 'WSBK';
export const source = { name: 'worldsbk.com results', url: 'https://www.worldsbk.com/en/results' };

// Category source_ids to keep, in display order. SPB (Supersport 300 successor)
// and the one-make cups are skipped; add them here if anyone asks.
const WANTED = ['SBK', 'SSP'];

const SESSION_TYPES = [
  [/superpole race|sprc/i, 'sprint'],
  [/race|^rc\d/i, 'race'],
  [/superpole|^sp\b|qual/i, 'qualifying'],
  [/warm/i, 'warmup'],
  [/practice|^fp\d/i, 'practice'],
];

function sessionType(short, description) {
  const s = `${short} ${description}`;
  for (const [re, t] of SESSION_TYPES) if (re.test(s)) return t;
  return 'other';
}

function includedMap(payload) {
  const map = new Map();
  for (const inc of payload.included ?? []) map.set(`${inc.type.replace(/s$/, '')}:${inc.id}`, inc.attributes);
  return map;
}

function rowsFrom(payload, type) {
  const inc = includedMap(payload);
  const data = [...(payload.data ?? [])].sort((a, b) => (a.attributes.position ?? 999) - (b.attributes.position ?? 999));
  const timed = type === 'race' || type === 'sprint';
  const leader = data[0]?.attributes;
  // On a race restarted after a red flag the API's `time` for the second
  // part is not a race time at all (Magny-Cours 2026 Race 1 reads 45 hours
  // for a 12-lap sprint to the flag) while the differences between rows are
  // still right. A leader "time" over three hours in a sprint-length race is
  // that case: keep the gaps, drop the times.
  const bogusTimes = timed && leader?.time > 3 * 3600 * 1000;
  return data.map((d) => {
    const a = d.attributes;
    const rider = inc.get(`rider:${d.relationships?.rider?.data?.id}`);
    const team = inc.get(`team:${d.relationships?.team?.data?.id}`);
    const classified = /classified/i.test(a.status ?? '') && !/not/i.test(a.status ?? '');
    let gap = null;
    if (leader && a.position !== 1 && a.time) {
      if (timed && classified && a.laps != null && leader.laps != null && a.laps < leader.laps) {
        const n = leader.laps - a.laps;
        gap = `+${n} lap${n > 1 ? 's' : ''}`;
      } else if (a.time >= leader.time) {
        gap = `+${((a.time - leader.time) / 1000).toFixed(3)}`;
      }
    }
    return result({
      pos: a.position ?? null,
      number: a.number ?? null,
      name: rider ? `${rider.name} ${rider.surname}` : null,
      team: team?.name ?? null,
      laps: a.laps ?? null,
      time: a.time && !bogusTimes ? formatMs(a.time) : null,
      gap,
      bestLap: timed && a.fastest_lap_time ? formatMs(a.fastest_lap_time) : null,
      status: classified ? null : a.status ?? null,
    });
  });
}

export async function fetchSeason({ season, previous, full, log }) {
  const rounds = (await getJson(`${BASE}/wsbk-events/v1/seasons/${season}/rounds`, { delayMs: DELAY })).data
    .map((r) => ({ id: r.id, ...r.attributes, categoryIds: (r.relationships?.categories?.data ?? []).map((c) => c.id) }))
    .sort((a, b) => a.sequence_order - b.sequence_order);
  const categories = (await getJson(`${BASE}/wsbk-events/v1/seasons/${season}/categories`, { delayMs: DELAY })).data
    .map((c) => ({ id: c.id, ...c.attributes }))
    .filter((c) => WANTED.includes(c.source_id))
    .sort((a, b) => WANTED.indexOf(a.source_id) - WANTED.indexOf(b.source_id));
  const classes = categories.map((c) => ({ id: c.source_id.toLowerCase(), name: c.name }));
  log?.(`WSBK ${season}: ${rounds.length} rounds, classes ${classes.map((c) => c.name).join('/')}`);

  const prevEvents = new Map((previous?.events ?? []).map((e) => [e.id, e]));
  const events = [];
  for (const r of rounds) {
    const eventId = r.source_id.toLowerCase();
    const prev = prevEvents.get(eventId);
    if (prev?.complete && !full) {
      events.push({ ...prev, round: r.sequence_order });
      continue;
    }
    log?.(`  ${r.source_id} ${r.description}`);
    const raw = (await getJson(`${BASE}/wsbk-events/v1/seasons/${season}/rounds/${r.source_id}/sessions`, { delayMs: DELAY })).data;
    const sessions = [];
    let allDone = true;
    for (const cat of categories) {
      const mine = raw
        .filter((s) => s.relationships?.category?.data?.id === cat.source_id)
        .sort((a, b) => String(a.attributes.start_date_utc).localeCompare(String(b.attributes.start_date_utc)));
      for (const s of mine) {
        const a = s.attributes;
        const type = sessionType(a.short_name, a.description);
        const prevSession = prev?.sessions?.find((ps) => ps.id === s.id);
        let results = full ? null : prevSession?.results ?? null;
        if (a.status === 'FINISHED' && !results) {
          const payload = await getJson(
            `${BASE}/wsbk-results/v1/seasons/${season}/categories/${cat.source_id}/rounds/${r.source_id}/sessions/${a.source_id}/results`,
            { delayMs: DELAY },
          );
          results = rowsFrom(payload, type);
          if (!results.length) results = null;
        }
        if (a.status !== 'FINISHED' || !results) allDone = false;
        sessions.push({
          id: s.id,
          classId: cat.source_id.toLowerCase(),
          type,
          name: String(a.description || a.short_name).trim(),
          startUtc: a.effective_start_date_utc ?? a.start_date_utc ?? null,
          endUtc: a.effective_end_date_utc ?? a.end_date_utc ?? null,
          status: sessionStatus(a.start_date_utc, a.end_date_utc, a.status, !!results),
          results,
        });
      }
    }
    if (!sessions.length) allDone = false;
    const dateStart = String(r.start_date).slice(0, 10);
    const dateEnd = String(r.end_date).slice(0, 10);
    const status = eventStatus(dateStart, dateEnd, r.status);
    events.push({
      id: eventId,
      round: r.sequence_order,
      name: r.description,
      shortName: r.brief_description ?? r.source_id,
      circuit: r.name,
      location: null,
      country: r.country_iso ?? null,
      dateStart,
      dateEnd,
      status,
      officialUrl: `https://www.worldsbk.com/en/results/${season}/${r.source_id.toLowerCase()}/sbk/001`,
      complete: status === 'finished' && r.status === 'FINISHED' && allDone,
      sessions,
    });
  }

  log?.(`WSBK ${season}: standings`);
  const standings = [];
  for (const cat of categories) {
    const riders = await getJson(`${BASE}/wsbk-results/v1/seasons/${season}/categories/${cat.source_id}/riders/standings`, { delayMs: DELAY });
    const inc = includedMap(riders);
    standings.push({
      classId: cat.source_id.toLowerCase(),
      type: 'riders',
      name: `${cat.name} Riders' Championship`,
      rows: (riders.data ?? [])
        .sort((a, b) => a.attributes.position - b.attributes.position)
        .map((d) => {
          const rider = inc.get(`rider:${d.relationships?.rider?.data?.id}`);
          const team = inc.get(`team:${d.relationships?.team?.data?.id}`);
          return standingRow({
            pos: d.attributes.position ?? null,
            name: rider ? `${rider.name} ${rider.surname}` : null,
            number: d.attributes.number ?? null,
            team: team?.name ?? null,
            points: d.attributes.points ?? null,
          });
        }),
    });
    const mans = await getJson(`${BASE}/wsbk-results/v1/seasons/${season}/categories/${cat.source_id}/manufacturers/standings`, { delayMs: DELAY });
    const minc = includedMap(mans);
    standings.push({
      classId: cat.source_id.toLowerCase(),
      type: 'manufacturers',
      name: `${cat.name} Manufacturers' Championship`,
      rows: (mans.data ?? [])
        .sort((a, b) => a.attributes.position - b.attributes.position)
        .map((d) => {
          const mid = d.relationships?.manufacturer?.data?.id;
          const man = minc.get(`manufacturer:${mid}`);
          return standingRow({ pos: d.attributes.position ?? null, name: man?.name ?? mid ?? null, points: d.attributes.points ?? null });
        }),
    });
  }

  return { classes, events, standings };
}
