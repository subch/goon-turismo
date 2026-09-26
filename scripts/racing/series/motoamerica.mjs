// MotoAmerica via two of its own sites:
//
//   results.motoamerica.com   the timing archive. Its page embeds the whole
//                             catalogue (years -> events -> classes ->
//                             sessions, each with a "namingConvention" like
//                             26_11_TEX_SBK_R1) and every session's
//                             classification is a MyLaps Orbits PDF at
//                             results/<year>/<EVENT>/<naming>_allrep.pdf.
//   motoamerica.com/result/   the championship points table per class.
//
// The Orbits PDF is column-major once pdf-parse flattens it: the text reads
// "Pos" then every position, "No." then every number, "Name" then every
// name, and so on. Rows are rebuilt by zipping those blocks; a column that
// is blank for some riders (Diff for the winner, times for DNFs) comes back
// short, so those columns are only trusted for the classified rows.
import { getText, textOf, decodeEntities } from '../lib/http.mjs';
import { getPdfText, lines } from '../lib/pdf.mjs';
import { eventStatus, sessionStatus, result, standingRow, slug } from '../lib/schema.mjs';

const RESULTS = 'https://results.motoamerica.com';
const SITE = 'https://www.motoamerica.com';
const DELAY = 400;

export const id = 'motoamerica';
export const name = 'MotoAmerica';
export const shortName = 'MotoAmerica';
export const tier = 'other';
export const source = { name: 'results.motoamerica.com', url: 'https://results.motoamerica.com/' };

// Class code in the archive -> [display name, slug on motoamerica.com/result/]
const WANTED = {
  SBK: ['Superbike', 'superbike'],
  SSP: ['Supersport', 'supersport'],
  TWN: ['Twins Cup', 'twins-cup'],
  KTB: ['King of the Baggers', 'king-of-the-baggers'],
  MSH: ['Super Hooligan', 'super-hooligan'],
};

const SESSION_TYPES = [
  [/^R\d/, 'race'],
  [/^Q|^TA$/, 'qualifying'],
  [/^WU/, 'warmup'],
  [/^P\d|^FP/, 'practice'],
];

function sessionType(code, label) {
  for (const [re, t] of SESSION_TYPES) if (re.test(code)) return t;
  if (/race/i.test(label)) return 'race';
  if (/qual|time attack/i.test(label)) return 'qualifying';
  if (/warm/i.test(label)) return 'warmup';
  if (/practice/i.test(label)) return 'practice';
  return 'other';
}

/** The archive's catalogue for one season, out of the SSR'd page. */
function parseCatalogue(html, season) {
  const yy = String(season).slice(-2);
  const events = new Map();
  // Event blocks: {id:"TEX",name:"8.2026 MotoAmerica Superbikes at Texas",num:11,classes:...
  for (const m of html.matchAll(/\{id:"([A-Z0-9]+)",name:"([^"]*)",num:(\d+),classes:/g)) {
    const [, code, label, num] = m;
    // The same event code appears once per year; the year lives in the name.
    if (!label.includes(String(season))) continue;
    events.set(code, { code, name: label.replace(/^\d+\.\s*/, '').trim(), num: Number(num), order: Number(label.match(/^(\d+)\./)?.[1] ?? 0), classes: new Map() });
  }
  // Session entries: {id:"R1",name:"Race 1 ",namingConvention:"26_11_TEX_SBK_R1"}
  for (const m of html.matchAll(/\{id:"([A-Z0-9]+)",name:"([^"]*)",namingConvention:"(\d\d)_(\d+)_([A-Z0-9]+)_([A-Z0-9]+)_([A-Z0-9]+)"\}/g)) {
    const [, sid, label, y, , evt, cls, sess] = m;
    if (y !== yy) continue;
    const ev = events.get(evt);
    if (!ev || !WANTED[cls] || sess === 'PTS' || sid !== sess) continue;
    if (!ev.classes.has(cls)) ev.classes.set(cls, []);
    ev.classes.get(cls).push({ code: sess, name: label.trim(), naming: m[3] + '_' + m[4] + '_' + evt + '_' + cls + '_' + sess });
  }
  return [...events.values()].filter((e) => e.classes.size > 0).sort((a, b) => a.num - b.num);
}

/** Column-major Orbits text -> rows. */
function parseOrbits(text, type) {
  const ls = lines(text);
  const HEADERS = ['Pos', 'No.', 'Name', 'Class', 'Diff', 'Total Tm', 'Best Tm', 'Laps', 'Gap', 'Sponsor', 'Bike', 'Hometown', 'Avg. Speed', 'Best Speed', 'In Lap'];
  const blocks = {};
  let current = null;
  for (const l of ls) {
    if (HEADERS.includes(l)) {
      if (blocks[l]) break; // second page repeats the table
      current = l;
      blocks[l] = [];
      continue;
    }
    if (l === 'Sorted on Laps' || l === 'Sorted on Best Tm' || /^Announcements|^Printed:|^Margin of Victory|^Race Director/.test(l)) {
      current = null;
      continue;
    }
    if (current) blocks[current].push(l);
  }
  // "Not classified (75% = 9 Laps)" is a section heading inside the Pos
  // column, not a row; the DNF/DNS rows follow it.
  const pos = (blocks.Pos ?? []).filter((p) => !/^Not classified/i.test(p));
  const n = pos.length;
  if (!n || !blocks['No.'] || !blocks.Name) return null;
  const classified = pos.filter((p) => /^\d+$/.test(p)).length;
  const col = (key) => blocks[key] ?? [];
  const timeCol = type === 'race' || type === 'sprint' ? col('Total Tm') : col('Best Tm');
  const gapCol = col('Diff').length ? col('Diff') : col('Gap');
  // Diff is blank for P1 and runs one short; DNF rows may or may not have a value.
  const gapFor = (i) => (i === 0 ? null : gapCol[i - 1] ?? null);
  return Array.from({ length: n }, (_, i) => {
    const p = pos[i];
    const isPos = /^\d+$/.test(p);
    const g = gapFor(i);
    const rowStatus = isPos ? null : /^DNF|^DNS|^DSQ|^Not classified/i.test(p) ? p.replace(/\s*\(.*\)$/, '') : p;
    return result({
      pos: isPos ? Number(p) : null,
      number: col('No.')[i] ?? null,
      name: col('Name')[i] ?? null,
      team: col('Sponsor')[i] ?? null,
      make: col('Bike')[i] ?? null,
      cls: col('Class')[i] ?? null,
      laps: col('Laps')[i] ?? null,
      time: i < classified ? timeCol[i] ?? null : null,
      gap: isPos && g && !/DNF|DNS/i.test(g) ? (/^\d/.test(g) && !/Lap/i.test(g) ? `+${g}` : g) : null,
      bestLap: type === 'race' || type === 'sprint' ? (i < classified ? col('Best Tm')[i] ?? null : null) : null,
      status: rowStatus,
    });
  });
}

/** Event dates from the points table's column titles: "2026-04-17|MotoAmerica Superbikes at Road Atlanta|Race 1". */
function eventDatesFrom(html) {
  const out = [];
  for (const m of html.matchAll(/class="ma-cs-result-head" title="(\d{4}-\d{2}-\d{2})\|([^|"]+)\|([^"]*)"/g)) {
    out.push({ date: m[1], name: decodeEntities(m[2]).trim() });
  }
  return out;
}

const STOP = new Set(['motoamerica', 'superbike', 'superbikes', 'at', 'the', 'speedfest', 'of', 'and', 'road']);
function tokens(s) {
  return new Set(
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !STOP.has(t) && !/^\d{4}$/.test(t)),
  );
}
function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(1, Math.min(ta.size, tb.size));
}

function parseStandings(html) {
  const t = html.match(/<table class="ma-cs-table"[\s\S]*?<\/table>/);
  if (!t) return [];
  const body = t[0].split(/<tbody[^>]*>/)[1] ?? '';
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((r) => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => textOf(c[1])))
    .filter((c) => c.length >= 4 && /^\d+$/.test(c[0]))
    .map((c) => standingRow({ pos: Number(c[0]), number: c[1], name: c[2], points: Number(c[3]) || 0 }));
}

export async function fetchSeason({ season, previous, full, log }) {
  const html = await getText(`${RESULTS}/`, { delayMs: DELAY });
  const catalogue = parseCatalogue(html, season);
  if (!catalogue.length) throw new Error(`MotoAmerica: no ${season} events in the results archive page`);
  log?.(`MotoAmerica ${season}: ${catalogue.length} events in the archive`);

  // Standings per class, which also carry the calendar dates.
  const classes = [];
  const standings = [];
  let dateHints = [];
  for (const [code, [label, pageSlug]] of Object.entries(WANTED)) {
    if (!catalogue.some((e) => e.classes.has(code))) continue;
    classes.push({ id: code.toLowerCase(), name: label });
    try {
      const page = await getText(`${SITE}/result/?ma_season=${season}&ma_class=${pageSlug}`, { delayMs: DELAY });
      const rows = parseStandings(page);
      if (rows.length) standings.push({ classId: code.toLowerCase(), type: 'riders', name: `${label} Championship`, rows });
      if (code === 'SBK') dateHints = eventDatesFrom(page);
    } catch (err) {
      log?.(`  ${label} standings unavailable: ${err.message}`);
    }
  }

  const prevEvents = new Map((previous?.events ?? []).map((e) => [e.id, e]));
  const events = [];
  for (const ev of catalogue) {
    const eventId = slug(ev.code);
    const prev = prevEvents.get(eventId);
    if (prev?.complete && !full) {
      events.push(prev);
      continue;
    }
    // Dates: best token match against the points table's column titles.
    const dates = dateHints
      .map((h) => ({ ...h, score: similarity(h.name, ev.name) }))
      .filter((h) => h.score >= 0.5)
      .sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
    const best = dates[0];
    const sameEvent = best ? dates.filter((d) => d.name === best.name).map((d) => d.date).sort() : [];
    let dateStart = prev?.dateStart ?? sameEvent[0] ?? null;
    let dateEnd = prev?.dateEnd ?? (sameEvent.length ? sameEvent[sameEvent.length - 1] : dateStart);
    let status = dateStart ? eventStatus(dateStart, dateEnd) : 'upcoming';
    log?.(`  ${ev.name} (${dateStart ?? 'date unknown'})`);

    // The PDFs carry the session's own date ("9/12/2026 15:12"), which is
    // the only calendar the non-Superbike weekends (Daytona, Talent Cup at
    // MotoGP) have. So a PDF is always tried unless the event is known to be
    // in the future; a 404 is cheap and means "not run yet".
    const pdfDates = new Set();
    const sessions = [];
    let allDone = true;
    let anyResults = false;
    for (const [cls, list] of ev.classes) {
      for (const s of list) {
        const type = sessionType(s.code, s.name);
        const sessionId = `${ev.code}-${cls}-${s.code}`.toLowerCase();
        const prevSession = prev?.sessions?.find((p) => p.id === sessionId);
        let results = full ? null : prevSession?.results ?? null;
        const knownFuture = dateStart && dateStart > new Date().toISOString().slice(0, 10);
        if (!results && !knownFuture) {
          const text = await getPdfText(`${RESULTS}/results/${season}/${ev.code}/${s.naming}_allrep.pdf`, { delayMs: DELAY });
          results = text ? parseOrbits(text, type) : null;
          if (results && !results.length) results = null;
          for (const d of text?.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}) \d{1,2}:\d{2}\b/g) ?? []) {
            pdfDates.add(`${d[3]}-${d[1].padStart(2, '0')}-${d[2].padStart(2, '0')}`);
          }
        }
        if (results) anyResults = true;
        else allDone = false;
        sessions.push({
          id: sessionId,
          classId: cls.toLowerCase(),
          type,
          name: s.name,
          startUtc: null,
          endUtc: null,
          status: results ? 'finished' : 'upcoming',
          results,
        });
      }
    }
    if (pdfDates.size) {
      const sorted = [...pdfDates].sort();
      dateStart = dateStart && dateStart < sorted[0] ? dateStart : sorted[0];
      dateEnd = dateEnd && dateEnd > sorted[sorted.length - 1] ? dateEnd : sorted[sorted.length - 1];
      status = eventStatus(dateStart, dateEnd);
    }
    for (const s of sessions) if (!s.results && status === 'finished') s.status = 'finished';
    events.push({
      id: eventId,
      round: ev.order || ev.num,
      name: ev.name,
      shortName: ev.name.replace(/^.*\bat\b\s*/i, '') || ev.code,
      circuit: null,
      location: null,
      country: 'USA',
      dateStart,
      dateEnd,
      status: status === 'upcoming' && anyResults ? 'finished' : status,
      officialUrl: `${RESULTS}/`,
      complete: status === 'finished' && allDone,
      test: /test/i.test(ev.name) || undefined,
      sessions,
    });
  }
  events.sort((a, b) => String(a.dateStart ?? '9').localeCompare(String(b.dateStart ?? '9')) || a.round - b.round);
  events.forEach((e, i) => (e.round = i + 1));

  return { classes, events, standings };
}
