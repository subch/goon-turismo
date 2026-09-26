// Nürburgring Langstrecken-Serie (NLS, the former VLN) via the series' own
// result archive at nuerburgring-langstrecken-serie.de. Each race weekend
// has a set of PDFs from wige (the timing provider) under
// /wp-content/uploads/ergebnisse/<date><code>.pdf:
//
//   t   qualifying     tq  top qualifying (24h Qualifiers)
//   r   race           k   class results     s  entry list   *l  lap-by-lap
//
// The race and qualifying PDFs are parsed here; the overall classification
// carries every car's class ("SP9 PRO", "Cup2", "V4"...), which is what
// makes any one car findable. The series has no simple overall standings
// (points are per class), so no standings table is kept; the archive page
// is linked from every event.
//
// The PDF text, once flattened, reads per car:
//
//   1  77                         position, car number
//   SP9 PRO                       class
//   BMW M4 GT3 EVO28 4:08:08.316  vehicle, then laps, then total time (race)
//   164.914    8:01.584   9       [gap] avg fastest-lap on-lap   (race)
//   B:Schubert Motorsport         entrant
//   43387182.084                  licence/interval noise
//   Wittmann Marco, Fürth         drivers, each followed by a licence line
//   DE-ITA-10375
//
// Qualifying differs only in the vehicle line: "Porsche 911 GT3 R77:51.957"
// is vehicle + laps (7) + best lap (7:51.957) with no space between.
import { getText, decodeEntities } from '../lib/http.mjs';
import { getPdfText, lines } from '../lib/pdf.mjs';
import { eventStatus, result } from '../lib/schema.mjs';

const SITE = 'https://www.nuerburgring-langstrecken-serie.de';
const DELAY = 500;

export const id = 'nls';
export const name = 'Nürburgring Langstrecken-Serie';
export const shortName = 'NLS';
export const tier = 'other';
export const source = { name: 'NLS result archive', url: `${SITE}/language/en/result-archives/` };
export const classes = [{ id: 'nls', name: 'Overall' }];

const SESSION_CODES = [
  ['t', 'Qualifying', 'qualifying'],
  ['tq', 'Top Qualifying', 'qualifying'],
  ['r', 'Race', 'race'],
];

const HEAD_RE = /^(\d{1,3})\s+(\d{1,3})$/;
const TIME_RE = /(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{1,2}:\d{2}\.\d{3})/;
const VEHICLE_RE = /^(.*?)(\d{1,3})\s*(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{1,2}:\d{2}\.\d{3})$/;
const RACE_GAP_RE = /^(?:(\d+ Runden?|\S+)\s+)?(\d{2,3}\.\d{3})\s+(\d{1,2}:\d{2}\.\d{3})\s+(\d+)$/;
const DRIVER_RE = /^'?([^,']+?)'?\s*,\s*[^,]+$/;
// A driver's name line is always followed by a licence line ("DE-ITC-C17889",
// "AT-JAC1353", "GB-ITB 174582"), sometimes with timing noise glued on.
const LICENCE_RE = /^[A-Z]{2}-[A-Z0-9]|^[A-Z]{2,4}\s?\d{3,}/;

// "BMW M4 GT423 4:03:29.684" is vehicle + laps + time with nothing between
// the vehicle's trailing digit and the lap count. Every split is a
// candidate; the right one has a plausible lap count (at most the leader's,
// no leading zero) and, among those, the most laps -- so "GT4" + 23, not
// "GT" + 423, and "i30" + 18, not "i3" + 018.
function splitVehicle(line, maxLaps, type) {
  const m = line.match(VEHICLE_RE);
  if (!m) return null;
  // The leader has no reference row, so cap by what a session can hold: a
  // qualifying is a dozen laps at most, a race under a hundred. Without
  // this "GT387:52.393" reads as 38 laps instead of GT3 + 8 laps.
  if (!maxLaps) maxLaps = type === 'race' ? 100 : 15;
  const time = m[3];
  const beforeTime = line.slice(0, line.length - time.length).replace(/\s+$/, '');
  const digits = beforeTime.match(/(\d{1,3})$/)?.[1] ?? '';
  const candidates = [];
  for (let n = 1; n <= digits.length; n++) {
    const laps = digits.slice(digits.length - n);
    if (laps.length > 1 && laps.startsWith('0')) continue;
    const value = Number(laps);
    if (value < 1 || (maxLaps && value > maxLaps) || value > 300) continue;
    candidates.push({ vehicle: beforeTime.slice(0, beforeTime.length - n).trim(), laps: value });
  }
  const pick = candidates.sort((a, b) => b.laps - a.laps)[0];
  return pick ? { ...pick, time } : { vehicle: m[1].trim(), laps: Number(m[2]), time };
}

function toMs(t) {
  const m = String(t).match(/^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})$/);
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}

function fmtGapMs(ms) {
  if (ms == null || ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  const frac = String(ms % 1000).padStart(3, '0');
  return s >= 60 ? `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${frac}` : `+${s}.${frac}`;
}

export function parseWige(text, type) {
  const ls = lines(text);
  const rows = [];
  let cur = null;
  const flush = () => {
    if (cur) rows.push(cur);
    cur = null;
  };
  const newRow = (pos, number, cls, status) => ({ pos, number, cls, status, drivers: [], team: null, vehicle: null, laps: null, time: null, gap: null, bestLap: null });
  let lastPos = 0; // last classified position seen
  let unclassified = false; // past the classification, into the DNC/DNF/DNS block
  let pendingStatus = null;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const next = ls[i + 1] ?? '';
    // A class name is short and plain: "SP9 PRO", "Cup2", "AT 1", "VT2", "V6".
    const classLine = /^[A-Za-z][A-Za-z0-9 .+-]{0,14}$/.test(next) && !/^B:/.test(next);
    // The unclassified block: a status word, then entries as a bare car
    // number and a class line. Not every entry repeats the status, so the
    // last one seen carries over.
    if (/^(DNC|DNF|DNS|DSQ|DISQ|NC)$/.test(l)) {
      unclassified = true;
      pendingStatus = l;
      continue;
    }
    if (unclassified) {
      if (HEAD_RE.test(l) && classLine) break; // the class-winners table that follows
      if (/^\d{1,3}$/.test(l) && classLine) {
        flush();
        cur = newRow(null, l, next.trim(), pendingStatus);
        i += 1;
        continue;
      }
    } else {
      // "22  18" -- or, with a three-digit car number, "23959": position and
      // number run together. The expected position resolves the split.
      let head = l.match(HEAD_RE);
      // (Only once the classification has started: the first row always has
      // its space, and the page header has bare numbers of its own.)
      if (!head && lastPos > 0 && classLine && /^\d{2,6}$/.test(l)) {
        const want = String(lastPos + 1);
        if (l.startsWith(want) && l.length > want.length) head = [l, want, l.slice(want.length)];
      }
      if (head && classLine) {
        // Positions only ever go up; a reset is the class-winners table that
        // follows the classification, and the end of what we want.
        if (Number(head[1]) <= lastPos) break;
        flush();
        cur = newRow(Number(head[1]), head[2], next.trim(), null);
        lastPos = Number(head[1]);
        i += 1;
        continue;
      }
      // A bare car number with a class line, once the classification has
      // started, is an unclassified entry listed without a status word
      // (the qualifying sheets do this).
      if (!head && lastPos > 0 && /^\d{1,3}$/.test(l) && classLine) {
        unclassified = true;
        pendingStatus = 'NC';
        flush();
        cur = newRow(null, l, next.trim(), pendingStatus);
        i += 1;
        continue;
      }
    }
    if (!cur) continue;
    if (cur.vehicle == null) {
      const v = splitVehicle(l, rows[0]?.laps ?? null, type);
      if (v) {
        cur.vehicle = v.vehicle;
        cur.laps = v.laps;
        cur.time = v.time;
        continue;
      }
    }
    if (type === 'race' && cur.vehicle && cur.gap == null && cur.bestLap == null) {
      const g = l.match(RACE_GAP_RE);
      if (g) {
        cur.gap = g[1] ? g[1].replace(/^(\d+) Runden?$/, (_, n) => `+${n} lap${n > 1 ? 's' : ''}`) : null;
        cur.bestLap = g[3];
        continue;
      }
    }
    if (/^B:/.test(l)) {
      cur.team = l.replace(/^B:/, '').trim();
      continue;
    }
    // Drivers: a "Lastname Firstname, Town" line directly followed by a
    // licence line. Some entries have no "B:" entrant line at all (the
    // Cayman cups show "A(CUP3)" instead), so this doesn't wait for one.
    const d = l.match(DRIVER_RE);
    if (d && LICENCE_RE.test(ls[i + 1] ?? '') && !/\d{3}/.test(d[1])) cur.drivers.push(d[1].trim());
  }
  flush();
  if (!rows.length) return null;
  const leader = rows[0];
  return rows.map((r) => {
    let gap = r.gap ? (/^\d/.test(r.gap) ? `+${r.gap}` : r.gap) : null;
    if (type !== 'race' && r !== leader && r.time && leader.time) gap = fmtGapMs(toMs(r.time) - toMs(leader.time));
    if (type === 'race' && !gap && r !== leader && r.laps != null && leader.laps != null && r.laps < leader.laps) {
      const n = leader.laps - r.laps;
      gap = `+${n} lap${n > 1 ? 's' : ''}`;
    }
    return result({
      pos: r.pos,
      number: r.number,
      name: r.drivers.join(' / ') || null,
      team: r.team,
      make: r.vehicle,
      cls: r.cls,
      laps: r.laps,
      time: r.time,
      gap: r.pos == null ? null : gap,
      bestLap: type === 'race' ? r.bestLap : null,
      status: r.status,
    });
  });
}

/** The archive page: one block per race day with a date, a title and PDF links. */
function parseArchive(html) {
  const flat = html.replace(/\s+/g, ' ');
  const out = [];
  const re = /(\d{2})\.(\d{2})\.(\d{4})/g;
  const marks = [];
  let m;
  while ((m = re.exec(flat))) marks.push({ index: m.index, date: `${m[3]}-${m[2]}-${m[1]}` });
  for (let i = 0; i < marks.length; i++) {
    const chunk = flat.slice(marks[i].index, marks[i + 1]?.index ?? flat.length);
    const pdfs = [...chunk.matchAll(/href="([^"]*\/ergebnisse\/(\d{4}-\d{2}-\d{2})([a-z]{1,2})\.pdf)"/g)];
    if (!pdfs.length) continue;
    const title = decodeEntities(
      chunk
        .replace(/^\d{2}\.\d{2}\.\d{4}/, '')
        .replace(/<[^>]+>/g, '|')
        .split('|')
        .map((s) => s.trim())
        .find((s) => s.length > 3 && !/^Prov|^Qualifying|^Race|^Lap|^Classes|^Top/i.test(s)) ?? '',
    );
    if (!title) continue;
    out.push({
      date: marks[i].date,
      name: title,
      pdfs: Object.fromEntries(pdfs.map((p) => [p[3], p[1].startsWith('http') ? p[1] : SITE + p[1]])),
    });
  }
  // The same date can appear in the news blurbs; keep the first block per date+title.
  const seen = new Set();
  return out.filter((e) => {
    const k = `${e.date}|${e.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function fetchSeason({ season, previous, full, log }) {
  const html = await getText(`${SITE}/language/en/result-archives/?jahr=${season}/`, { delayMs: DELAY });
  const days = parseArchive(html).filter((d) => d.date.startsWith(String(season)));
  if (!days.length) throw new Error(`NLS: no ${season} race days found on the archive page`);
  log?.(`NLS ${season}: ${days.length} race days`);

  const prevEvents = new Map((previous?.events ?? []).map((e) => [e.id, e]));
  const events = [];
  for (const [i, day] of days.entries()) {
    const eventId = day.date;
    const prev = prevEvents.get(eventId);
    if (prev?.complete && !full) {
      events.push({ ...prev, round: i + 1 });
      continue;
    }
    const status = eventStatus(day.date, day.date);
    const cancelled = !day.pdfs.r && !day.pdfs.t && status === 'finished' && Object.keys(day.pdfs).length <= 1;
    log?.(`  ${day.date} ${day.name} [${Object.keys(day.pdfs).join(',')}]`);
    const sessions = [];
    let allDone = true;
    for (const [code, label, type] of SESSION_CODES) {
      const url = day.pdfs[code];
      if (!url && !(code === 'r' || code === 't')) continue; // top qualifying only where it exists
      const sessionId = `${eventId}-${code}`;
      const prevSession = prev?.sessions?.find((p) => p.id === sessionId);
      let results = full ? null : prevSession?.results ?? null;
      if (!results && url) {
        const text = await getPdfText(url, { delayMs: DELAY });
        results = text ? parseWige(text, type) : null;
      }
      if (!results) allDone = false;
      sessions.push({
        id: sessionId,
        classId: 'nls',
        type,
        name: label,
        startUtc: null,
        endUtc: null,
        status: results ? 'finished' : cancelled ? 'cancelled' : status === 'finished' ? 'finished' : 'upcoming',
        results,
      });
    }
    events.push({
      id: eventId,
      round: i + 1,
      name: day.name,
      shortName: day.name.replace(/^\d+\.\s*/, ''),
      circuit: 'Nürburgring Nordschleife',
      location: 'Nürburg',
      country: 'Germany',
      dateStart: day.date,
      dateEnd: day.date,
      status: cancelled ? 'cancelled' : status,
      officialUrl: `${SITE}/language/en/result-archives/?jahr=${season}/`,
      complete: (status === 'finished' && allDone) || cancelled,
      sessions,
    });
  }

  return { classes, events, standings: [] };
}
