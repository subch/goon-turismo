// The one shape every series adapter produces. Pages under src/pages/racing/
// render this and nothing else, so adding a series means writing one adapter
// that fills this in -- see scripts/racing/series/README.md.
//
// data/racing/<series>/<season>.json = SeasonFile:
//
//   {
//     series: 'f1',                      // adapter id, also the URL slug
//     season: 2026,
//     syncedAt: ISO,
//     source: { name, url },             // credited in the page footer
//     classes: [{ id, name }],           // MotoGP/Moto2/Moto3, Hypercar/LMGT3, ...
//     events: [Event],                   // in calendar order
//     standings: [Standing],
//   }
//
//   Event = {
//     id,                                // stable within the season, URL-safe
//     round: number|null,
//     name, shortName,
//     circuit, location, country,        // any may be null
//     dateStart, dateEnd,                // YYYY-MM-DD (track-local calendar dates)
//     status: 'finished'|'live'|'upcoming'|'cancelled',
//     officialUrl,                       // where to go for everything we don't keep
//     complete: boolean,                 // every session finished AND fetched; the
//                                        // sync skips these unless --full
//     sessions: [Session],
//   }
//
//   Session = {
//     id, classId,
//     type: 'practice'|'qualifying'|'sprint'|'race'|'warmup'|'other',
//     name,                              // "FP2", "Q2", "Sprint", "Race 1"...
//     startUtc, endUtc,                  // ISO or null
//     status: 'finished'|'live'|'upcoming'|'cancelled',
//     results: [Result] | null,          // null = not published yet
//   }
//
//   Result = {
//     pos: number|null, number, name, team, make, cls,
//     laps, time, gap, interval, bestLap, points, status
//   }                                    // strings as the source shows them; null when absent
//                                        // cls = class within a mixed grid (NLS, MotoAmerica, WRC)
//
//   Standing = {
//     classId, type: 'drivers'|'riders'|'teams'|'constructors'|'manufacturers',
//     name,                              // table heading
//     rows: [{ pos, name, number, team, make, points, wins }],
//   }

export function classifySession(label) {
  const s = String(label || '').toLowerCase();
  if (/warm/.test(s)) return 'warmup';
  if (/sprint|spr\b|superpole race|sprc/.test(s)) return 'sprint';
  if (/race|rac\b|\brc\d|grand prix/.test(s)) return 'race';
  if (/qual|hyperpole|superpole|\bq\d|\bsp\b|\bpr\b|shootout/.test(s)) return 'qualifying';
  if (/practice|\bfp\d?|\bp\d\b/.test(s)) return 'practice';
  return 'other';
}

/** Event status from its calendar window; the source's own flag can override
 * with 'cancelled'. Compared as UTC calendar dates, same as isEventActive() on
 * the GT7 side of the site. */
export function eventStatus(dateStart, dateEnd, sourceStatus) {
  if (sourceStatus && /cancel/i.test(sourceStatus)) return 'cancelled';
  const today = new Date().toISOString().slice(0, 10);
  if (dateEnd && today > dateEnd) return 'finished';
  if (dateStart && today >= dateStart && (!dateEnd || today <= dateEnd)) return 'live';
  if (sourceStatus && /finish/i.test(sourceStatus)) return 'finished';
  return 'upcoming';
}

export function sessionStatus(startUtc, endUtc, sourceStatus, hasResults) {
  if (sourceStatus && /cancel/i.test(sourceStatus)) return 'cancelled';
  if (hasResults || (sourceStatus && /finish/i.test(sourceStatus))) return 'finished';
  const now = Date.now();
  const start = startUtc ? Date.parse(startUtc) : NaN;
  const end = endUtc ? Date.parse(endUtc) : NaN;
  if (!Number.isNaN(end) && now > end) return 'finished';
  if (!Number.isNaN(start) && now >= start) return Number.isNaN(end) ? (now - start > 4 * 3600e3 ? 'finished' : 'live') : 'live';
  return 'upcoming';
}

export function result(fields) {
  return {
    pos: fields.pos ?? null,
    number: fields.number ?? null,
    name: fields.name ?? null,
    team: fields.team ?? null,
    make: fields.make ?? null,
    cls: fields.cls ?? null, // class within a mixed grid (NLS "SP9 PRO", MotoAmerica "SBC", WRC "WRC2")
    laps: fields.laps ?? null,
    time: fields.time ?? null,
    gap: fields.gap ?? null,
    interval: fields.interval ?? null,
    bestLap: fields.bestLap ?? null,
    points: fields.points ?? null,
    status: fields.status ?? null,
  };
}

export function standingRow(fields) {
  return {
    pos: fields.pos ?? null,
    name: fields.name ?? null,
    number: fields.number ?? null,
    team: fields.team ?? null,
    make: fields.make ?? null,
    points: fields.points ?? null,
    wins: fields.wins ?? null,
  };
}

/** "1:34:23.754" from milliseconds, or "25:43.767", or "1:29.694". */
export function formatMs(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return null;
  const total = Number(ms);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = ((total % 60000) / 1000).toFixed(3).padStart(6, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function slug(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
