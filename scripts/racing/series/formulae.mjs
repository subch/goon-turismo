// ABB FIA Formula E via fiaformulae.com's own Results & Standings page,
// which is server-rendered with plain query parameters:
//
//   ?season=12                                   round tiles for a season
//   ?season=12&round=17-london                   one round: venue, date, session chips
//   ?season=12&round=17-london&session=race      that session's classification
//   ?tab=drivers|teams|manufacturers&season=12   standings
//
// Seasons are numbered from 1 = 2014-15, so season N ends in 2014+N. A
// file year Y maps to season Y-2014, unless season Y-2013 (which starts in
// Y's December) has already run a round -- then that one is the live season.
//
// The site's pulselive API host has an expired certificate and the page
// itself is the only public source, so this is HTML parsing, kept to the
// row shapes seen on 2026-09-26 (results rows use <th scope="row"> for the
// driver cell).
import { getText, textOf, decodeEntities } from '../lib/http.mjs';
import { eventStatus, sessionStatus, result, standingRow, classifySession, slug } from '../lib/schema.mjs';

const SITE = 'https://www.fiaformulae.com';
const PAGE = `${SITE}/en/results-and-standings`;
const DELAY = 500;

export const id = 'formulae';
export const name = 'Formula E';
export const shortName = 'Formula E';
export const tier = 'other';
export const source = { name: 'fiaformulae.com results', url: PAGE };
export const classes = [{ id: 'fe', name: 'Formula E' }];

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// "16 Aug 2026" -> 2026-08-16
function parseDate(s) {
  const m = String(s ?? '').match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(MONTHS[m[2].toLowerCase()] ?? 0).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function cells(rowHtml) {
  return [...rowHtml.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => m[1]);
}

// Table rows, skipping the header row.
function tableRows(html) {
  const t = html.match(/<table[\s\S]*?<\/table>/);
  if (!t) return [];
  const body = t[0].split(/<tbody[^>]*>/)[1] ?? t[0];
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => cells(r[1])).filter((c) => c.length >= 3);
}

function linkText(cellHtml) {
  const a = cellHtml.match(/<a[^>]*>([\s\S]*?)<\/a>/);
  return a ? textOf(a[1]) : null;
}

// Strip the screen-reader phrases the site embeds ("Places gained", "position 13").
function clean(s) {
  return textOf(s).replace(/\b(Places (gained|lost)|position \d+|Position|Points|Starting grid position)\b/g, '').trim();
}

function parseResults(html, type) {
  const rows = tableRows(html);
  const out = [];
  for (const c of rows) {
    const posText = clean(c[0]).replace(/[^0-9A-Za-z]/g, '');
    const pos = Number(posText);
    const nameCell = c[1] ?? '';
    const driver = linkText(nameCell) ?? clean(nameCell).split(/\s{2,}/)[0];
    if (!driver) continue;
    const team = clean(c[2] ?? '') || null;
    const rest = c.slice(3).map(clean);
    // Race: Grid, Time, Pts, Pts(bonus) | Quali/practice: Time (and maybe gap)
    const timeIx = rest.findIndex((x) => /^\+?\d+:\d{2}(:\d{2})?\.\d{1,3}$|^\+\d+\.\d{1,3}$|^\d+ laps?$/i.test(x));
    const time = timeIx >= 0 ? rest[timeIx] : rest.find((x) => /\d:\d{2}\./.test(x)) ?? null;
    const grid = type === 'race' ? rest.find((x) => /^\d{1,2}$/.test(x)) ?? null : null;
    // Two "Pts" columns: race points, then the total with any bonus. Keep the total.
    const pts = type === 'race' ? rest.filter((x) => /^\d+$/.test(x)) : [];
    const points = pts.length ? Number(pts[pts.length - 1]) : null;
    out.push(
      result({
        pos: Number.isFinite(pos) && pos > 0 ? pos : null,
        name: driver,
        team,
        time: time && !/^\+/.test(time) ? time : null,
        gap: time && /^\+/.test(time) ? time : type === 'race' && time && /laps?$/i.test(time) ? `+${time}` : null,
        points: type === 'race' ? points : null,
        status: Number.isFinite(pos) && pos > 0 ? (grid ? `Grid ${grid}` : null) : posText || 'Not classified',
      }),
    );
  }
  return out.length ? out : null;
}

function parseStandings(html, kind) {
  const rows = tableRows(html);
  return rows
    .map((c) => {
      const pos = Number(clean(c[0]));
      const nameCell = c[1] ?? '';
      const name = linkText(nameCell) ?? clean(nameCell);
      const team = kind === 'drivers' ? clean(c[2] ?? '') || null : null;
      const points = Number(clean(c[c.length - 1]));
      return standingRow({ pos: Number.isFinite(pos) ? pos : null, name, team, points: Number.isFinite(points) ? points : null });
    })
    .filter((r) => r.pos != null && r.name);
}

function roundTiles(html) {
  const out = [];
  for (const m of html.matchAll(/data-testid="round-selector-tile-(\d+)"[^>]*href="([^"]*round=([^"&]+))"[^>]*>([\s\S]*?)<\/a>/g)) {
    const text = textOf(m[4].replace(/<svg[\s\S]*?<\/svg>/g, ' '));
    const date = parseDate(text);
    const venue = text
      .replace(/^RD\s*\d+\s*ROUND\s*\d+\s*/i, '')
      .replace(/\d{1,2}\s+[A-Za-z]{3}\s+\d{4}.*$/, '')
      .replace(/Host country: [A-Z]{2}/g, '')
      .trim();
    out.push({ round: Number(m[1]), key: decodeEntities(m[3]), venue, date });
  }
  return out;
}

export async function fetchSeason({ season, previous, full, log }) {
  let fe = season - 2014;
  // Has the next season (starting this December) begun? Then it is the one to show.
  const nextHtml = await getText(`${PAGE}?season=${fe + 1}`, { delayMs: DELAY }).catch(() => '');
  const nextTiles = nextHtml ? roundTiles(nextHtml) : [];
  const today = new Date().toISOString().slice(0, 10);
  if (nextTiles.some((t) => t.date && t.date <= today)) fe += 1;
  const seasonHtml = fe === season - 2013 ? nextHtml : await getText(`${PAGE}?season=${fe}`, { delayMs: DELAY });
  const tiles = roundTiles(seasonHtml);
  if (!tiles.length) throw new Error(`Formula E: no rounds found for season ${fe}`);
  const label = seasonHtml.match(/Season \d+ - (\d{4}-\d{2})/)?.[1] ?? String(season);
  log?.(`Formula E season ${fe} (${label}): ${tiles.length} rounds`);

  const prevEvents = new Map((previous?.events ?? []).map((e) => [e.id, e]));
  const events = [];
  for (const t of tiles) {
    const eventId = slug(t.key);
    const prev = prevEvents.get(eventId);
    if (prev?.complete && !full) {
      events.push(prev);
      continue;
    }
    const status = eventStatus(t.date, t.date);
    const sessions = [];
    let allDone = true;
    if (status !== 'upcoming') {
      log?.(`  R${t.round} ${t.venue} (${t.date})`);
      const roundHtml = await getText(`${PAGE}?season=${fe}&round=${encodeURIComponent(t.key)}`, { delayMs: DELAY });
      const chips = [...roundHtml.matchAll(/data-testid="session-([a-z0-9-]+)"[^>]*href="[^"]*session=([a-z0-9-]+)"[^>]*>([^<]*)</g)].map((m) => ({
        code: m[2],
        label: textOf(m[3]),
      }));
      for (const chip of chips.reverse()) {
        // Chips are listed newest first; reversed = chronological.
        const type = classifySession(chip.code.replace(/-/g, ' '));
        const sessionId = `${eventId}-${chip.code}`;
        const prevSession = prev?.sessions?.find((p) => p.id === sessionId);
        let results = full ? null : prevSession?.results ?? null;
        if (!results) {
          const html = await getText(`${PAGE}?season=${fe}&round=${encodeURIComponent(t.key)}&session=${chip.code}`, { delayMs: DELAY });
          results = parseResults(html, type);
        }
        if (!results) allDone = false;
        sessions.push({
          id: sessionId,
          classId: 'fe',
          type,
          name: chip.label,
          startUtc: null,
          endUtc: null,
          status: sessionStatus(null, null, status === 'finished' ? 'FINISHED' : null, !!results),
          results,
        });
      }
    } else {
      allDone = false;
    }
    events.push({
      id: eventId,
      round: t.round,
      name: `${t.venue} E-Prix`.replace(/\s+/g, ' '),
      shortName: t.venue,
      circuit: null,
      location: t.venue,
      country: null,
      dateStart: t.date,
      dateEnd: t.date,
      status,
      officialUrl: `${PAGE}?season=${fe}&round=${t.key}`,
      complete: status === 'finished' && sessions.length > 0 && allDone,
      sessions,
    });
  }

  log?.(`Formula E season ${fe}: standings`);
  const standings = [];
  for (const [tab, kind, title] of [
    ['drivers', 'drivers', "Drivers' Championship"],
    ['teams', 'teams', "Teams' Championship"],
    ['manufacturers', 'manufacturers', "Manufacturers' Championship"],
  ]) {
    const html = await getText(`${PAGE}?tab=${tab}&season=${fe}`, { delayMs: DELAY });
    const rows = parseStandings(html, kind);
    if (rows.length) standings.push({ classId: 'fe', type: kind, name: title, rows });
  }

  return { classes, events, standings, seasonLabel: label };
}
