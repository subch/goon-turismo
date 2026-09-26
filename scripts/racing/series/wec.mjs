// FIA World Endurance Championship via fiawec.com, the championship's own
// site. Three public pages do the work:
//
//   /en/season/<year>             race list for the season
//   /en/race/<slug>               one race: title, dates, every session with
//                                 its start timestamp and results-session id
//   /en/page/resultats-1          the results browser. It is a Symfony UX
//                                 "live component": the page ships the
//                                 component's props (with a server checksum),
//                                 and each dropdown change POSTs those props
//                                 plus the changed field back to
//                                 /en/_components/<name>/<action> and gets
//                                 the re-rendered HTML. We do exactly that.
//   /en/page/manufacturers-classification   all four standings tables
//
// Why not Al Kamel? fiawec.alkamelsystems.com publishes the same results as
// CSV/PDF, but its page carries an explicit "any attempt by 3rd parties to
// distribute ... will lead to legal action" notice. The user's brief was no
// takedown risk, so that domain is never touched. fiawec.com's own results
// pages carry no such notice and are what any fan opens to see the same table.
//
// WEC results tables list the car (number + team + manufacturer), not the
// drivers -- that's how the source presents them, so `name` is null and the
// pages fall back to "#8 Toyota Racing".
import { getText, request, textOf, decodeEntities } from '../lib/http.mjs';
import { classifySession, eventStatus, sessionStatus, result, standingRow, slug } from '../lib/schema.mjs';

const SITE = 'https://www.fiawec.com';
const COMPONENT = `${SITE}/en/_components/Editorial:CMS:CompleteResultsComponent`;
const DELAY = 500;

export const id = 'wec';
export const name = 'FIA World Endurance Championship';
export const shortName = 'WEC';
export const source = { name: 'fiawec.com results', url: 'https://www.fiawec.com/en/page/resultats-1' };

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

const PARTICLES = new Set(['de', 'da', 'di', 'del', 'della', 'van', 'von', 'der', 'den', 'la', 'le', 'du', 'dos', 'das', 'y']);

function titleCase(s) {
  return s
    .toLowerCase()
    .split(/(\s+|-|')/)
    .map((w, i) => (PARTICLES.has(w) && i > 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}

function ymd(d, m, y) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// "From 25 to 27 September 2026" | "From 30 May to 1 June 2026" | "14 April 2026"
function parseDateRange(text) {
  const t = text.trim();
  let m = t.match(/From (\d{1,2}) (?:([A-Za-z]+) )?to (\d{1,2}) ([A-Za-z]+) (\d{4})/i);
  if (m) {
    const [, d1, m1, d2, m2, y] = m;
    const mm2 = MONTHS[m2.toLowerCase()];
    const mm1 = m1 ? MONTHS[m1.toLowerCase()] : mm2;
    return { dateStart: ymd(d1, mm1, y), dateEnd: ymd(d2, mm2, y) };
  }
  m = t.match(/(\d{1,2}) ([A-Za-z]+) (\d{4})/);
  if (m) {
    const d = ymd(m[1], MONTHS[m[2].toLowerCase()], m[3]);
    return { dateStart: d, dateEnd: d };
  }
  return { dateStart: null, dateEnd: null };
}

function propsFrom(html) {
  const m = html.match(/data-live-name-value="Editorial:CMS:CompleteResultsComponent"[^>]*data-live-props-value="([^"]+)"/);
  if (!m) throw new Error('WEC: results component props not found on the results page (site markup changed?)');
  return JSON.parse(decodeEntities(m[1]));
}

function selectOptions(html, model) {
  const m = html.match(new RegExp(`<select[^>]*data-model="${model}"[^>]*>([\\s\\S]*?)</select>`));
  if (!m) return [];
  return [...m[1].matchAll(/<option([^>]*)value="([^"]*)"[^>]*>([^<]*)/g)].map((o) => ({
    value: Number(o[2]),
    label: textOf(o[3]),
    selected: /selected/.test(o[1]),
  }));
}

async function componentAction(props, action, updated) {
  const body = new URLSearchParams({ data: JSON.stringify({ props, updated, args: {} }) });
  const res = await request(`${COMPONENT}/${action}`, {
    method: 'POST',
    body,
    delayMs: DELAY,
    headers: {
      Accept: 'application/vnd.live-component+html',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  return res.text();
}

function parseTable(html) {
  const t = html.match(/<table[\s\S]*?<\/table>/);
  if (!t) return null;
  // The header row mixes <th> and <td> (the N° cell is a <td> on the Le Mans
  // table), so take every cell of the thead row or the columns shift by one.
  const theadRow = t[0].match(/<thead[^>]*>[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>/)?.[1] ?? '';
  const head = [...theadRow.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => textOf(m[1]).toLowerCase());
  const body = t[0].split(/<tbody[^>]*>/)[1] ?? '';
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
    [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]),
  );
  const col = (re) => head.findIndex((h) => re.test(h));
  const ix = {
    pos: col(/^pos/),
    comp: col(/competitor/),
    number: col(/^n°|^no\.?$|^num/),
    team: col(/^team/),
    laps: col(/^laps/),
    time: col(/total time/),
    bestLap: col(/best lap/),
    gap: col(/^gap/),
    interval: col(/^interval/),
  };
  const cell = (cells, i) => (i >= 0 && cells[i] != null ? textOf(cells[i]) : null);
  return rows
    .map((cells) => {
      const compHtml = ix.comp >= 0 ? cells[ix.comp] ?? '' : '';
      const make = compHtml.match(/<img[^>]*class="brand-logo"[^>]*alt="([^"]*)"/)?.[1] ?? compHtml.match(/alt="([^"#]*)"/)?.[1] ?? null;
      const pos = Number(cell(cells, ix.pos));
      return result({
        pos: Number.isFinite(pos) && pos > 0 ? pos : null,
        number: cell(cells, ix.number),
        team: cell(cells, ix.team),
        make: make ? textOf(make) : null,
        laps: cell(cells, ix.laps),
        time: ix.time >= 0 ? cell(cells, ix.time) : cell(cells, ix.bestLap),
        bestLap: ix.time >= 0 ? cell(cells, ix.bestLap) : null,
        gap: (cell(cells, ix.gap) || null) === '-' ? null : cell(cells, ix.gap) || null,
        interval: (cell(cells, ix.interval) || null) === '-' ? null : cell(cells, ix.interval) || null,
      });
    })
    .filter((r) => r.pos != null || r.number);
}

async function racePage(path) {
  const html = (await getText(`${SITE}${path}`, { delayMs: DELAY })).replace(/\s+/g, ' ');
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const title = h1 ? textOf(h1[1].replace(/<\/span>/g, ' ')) : slug(path);
  const dateText = html.match(/<\/h1>\s*<div[^>]*>\s*(From [^<]+|\d{1,2} [A-Za-z]+ \d{4})/)?.[1] ?? '';
  const sessions = [];
  // Each session is its own block: name, then a data-timestamp span, then
  // (only once results exist) a "Results" button carrying the session's
  // results-browser id. Splitting on the block wrapper keeps a session with
  // no button from swallowing the next one's id.
  // The results button is a live-component action before the weekend and a
  // plain link (?raceId=..&sessionId=..) once the weekend is under way; the
  // session id is what matters and both carry it. Mid-weekend the page can
  // also drop the timestamp span from sessions already run.
  const blocks = html.split(/<div class="d-flex flex-column align-items-start gap-1">/).slice(1);
  for (const b of blocks) {
    const nm = b.match(/<div class="fw-bold lh-sm\s*">([^<]+)<\/div>/)?.[1];
    const ts = b.match(/data-timestamp="(\d+)"/)?.[1];
    const sid = b.match(/data-live-id-param="(\d+)"/)?.[1] ?? b.match(/[?&]sessionId=(\d+)/)?.[1];
    if (nm) sessions.push({ name: textOf(nm), startUtc: ts ? new Date(Number(ts) * 1000).toISOString() : null, resultsId: sid ? Number(sid) : null });
  }
  return { title, ...parseDateRange(dateText), sessions };
}

export async function fetchSeason({ season, previous, full, log }) {
  // 1. The season's races, from the season page.
  const seasonHtml = await getText(`${SITE}/en/season/${season}`, { delayMs: DELAY });
  const racePaths = [...new Set([...seasonHtml.matchAll(/href="(\/en\/race\/[^"]+)"/g)].map((m) => m[1]))].filter((p) =>
    p.endsWith(`-${season}`),
  );
  if (!racePaths.length) throw new Error(`WEC: no race links on the ${season} season page`);
  log?.(`WEC ${season}: ${racePaths.length} race pages`);

  // 2. The results browser's state, and the season it should be looking at.
  const resultsHtml = await getText(`${SITE}/en/page/resultats-1`, { delayMs: DELAY });
  const props = propsFrom(resultsHtml);
  let browser = resultsHtml;
  const seasonOpt = selectOptions(browser, 'seasonId').find((o) => o.label === String(season));
  if (!seasonOpt) throw new Error(`WEC: results browser does not offer season ${season} (has ${selectOptions(browser, 'seasonId').map((o) => o.label).join(', ')})`);
  if (!seasonOpt.selected) browser = await componentAction(props, 'changeSeason', { seasonId: seasonOpt.value });
  const raceOpts = selectOptions(browser, 'raceId');
  const categoryOpts = selectOptions(browser, 'categoryId');
  const classNameOf = (label) => label.replace(/\b\w+/g, (w) => (/^LM/.test(w) ? w : w[0] + w.slice(1).toLowerCase()));
  // The category list is per race: Le Mans adds LMP2 to the season's usual
  // Hypercar/LMGT3, so classes are unioned in as each race's options are seen.
  const classes = categoryOpts.map((c) => ({ id: slug(c.label), name: classNameOf(c.label) }));
  const raceCategoryOpts = new Map(); // raceId -> category options
  const addClasses = (opts) => {
    for (const c of opts) if (!classes.some((k) => k.id === slug(c.label))) classes.push({ id: slug(c.label), name: classNameOf(c.label) });
  };

  // 3. Which results-browser race each race page is: matched through the
  //    session ids that both sides carry.
  const prevEvents = new Map((previous?.events ?? []).map((e) => [e.id, e]));
  const raceSessionIds = new Map(); // raceId -> [{value,label}]
  const sessionToRace = new Map();

  const events = [];
  for (const path of racePaths) {
    const eventId = path.replace(/^\/en\/race\//, '').replace(new RegExp(`-${season}$`), '');
    const isTest = /prologue|test/i.test(eventId);
    const prev = prevEvents.get(eventId);
    if (prev?.complete && !full) {
      events.push(prev);
      continue;
    }
    const page = await racePage(path);
    const status = eventStatus(page.dateStart, page.dateEnd);
    log?.(`  ${page.title} (${page.dateStart} → ${page.dateEnd}, ${page.sessions.length} sessions)`);
    // A page that has lost its timetable (seen mid-weekend) must not wipe
    // what an earlier sync already had: fall back to the previous file's
    // sessions, and to their start times where the page dropped one.
    if (!page.sessions.length && prev?.sessions?.length) {
      events.push({ ...prev, complete: false });
      continue;
    }
    for (const s of page.sessions) {
      if (!s.startUtc && s.resultsId) s.startUtc = prev?.sessions?.find((p) => p.id.startsWith(`${s.resultsId}-`))?.startUtc ?? null;
    }

    // Lazily walk the results browser's race list until one of them owns one
    // of this race page's session ids.
    let raceId = null;
    const wantIds = page.sessions.map((s) => s.resultsId).filter(Boolean);
    for (const sid of wantIds) if (sessionToRace.has(sid)) raceId = sessionToRace.get(sid);
    if (!raceId && wantIds.length) {
      for (const ro of raceOpts) {
        if (raceSessionIds.has(ro.value)) continue;
        const html = await componentAction(props, 'changeRace', { seasonId: seasonOpt.value, raceId: ro.value });
        const opts = selectOptions(html, 'sessionId');
        raceSessionIds.set(ro.value, opts);
        const cats = selectOptions(html, 'categoryId');
        if (cats.length) {
          raceCategoryOpts.set(ro.value, cats);
          addClasses(cats);
        }
        for (const o of opts) sessionToRace.set(o.value, ro.value);
        if (opts.some((o) => wantIds.includes(o.value))) {
          raceId = ro.value;
          break;
        }
      }
    }

    const sessions = [];
    let allDone = true;
    const raceCats = (raceId && raceCategoryOpts.get(raceId)) || categoryOpts;
    for (const s of page.sessions) {
      const type = classifySession(s.name);
      // "Hyperpole 1 - LMP2 & LMGT3": a " - <classes>" suffix names the classes
      // the session is for; anything else (practice, the race) is every class.
      const suffix = s.name.match(/\s+-\s+(.+)$/)?.[1]?.toUpperCase() ?? null;
      const classesFor = suffix ? raceCats.filter((c) => suffix.includes(c.label.toUpperCase())) : raceCats;
      for (const cat of classesFor) {
        const classId = slug(cat.label);
        const sessionId = `${s.resultsId ?? slug(s.name)}-${classId}`;
        const prevSession = prev?.sessions?.find((ps) => ps.id === sessionId);
        let results = full ? null : prevSession?.results ?? null;
        const started = s.startUtc ? Date.parse(s.startUtc) < Date.now() : status !== 'upcoming';
        if (!results && started && raceId && s.resultsId) {
          const html = await componentAction(props, 'changeCategory', {
            seasonId: seasonOpt.value,
            raceId,
            sessionId: s.resultsId,
            categoryId: cat.value,
          });
          results = /RESULTS AVAILABLE SOON/i.test(html) ? null : parseTable(html);
          if (results && !results.length) results = null;
        }
        if (!results) allDone = false;
        sessions.push({
          id: sessionId,
          classId,
          type,
          name: s.name.replace(/\s+-\s+.+$/, ''),
          startUtc: s.startUtc,
          endUtc: null,
          status: sessionStatus(s.startUtc, null, null, !!results),
          results,
        });
      }
    }
    sessions.sort((a, b) => String(a.startUtc ?? '9').localeCompare(String(b.startUtc ?? '9')) || a.classId.localeCompare(b.classId));

    events.push({
      id: eventId,
      round: null,
      name: page.title,
      shortName: page.title.replace(/^(\d+ Hours of|Rolex \d+ Hours of|TotalEnergies \d+ Hours of)\s*/i, ''),
      circuit: null,
      location: null,
      country: null,
      dateStart: page.dateStart,
      dateEnd: page.dateEnd,
      status,
      officialUrl: `${SITE}${path}`,
      complete: status === 'finished' && sessions.length > 0 && allDone,
      test: isTest || undefined,
      sessions,
    });
  }
  events.sort((a, b) => String(a.dateStart).localeCompare(String(b.dateStart)));
  events.forEach((e, i) => (e.round = i + 1));

  // 4. Standings. Four tables on one page, in a fixed order; each is named by
  //    the nearest preceding "... Championship" heading when there is one.
  log?.(`WEC ${season}: standings`);
  const stHtml = (await getText(`${SITE}/en/page/manufacturers-classification`, { delayMs: DELAY })).replace(/\s+/g, ' ');
  const standings = [];
  const tables = [...stHtml.matchAll(/<table[\s\S]*?<\/table>/g)];
  tables.forEach((t, i) => {
    const before = textOf(stHtml.slice(Math.max(0, t.index - 2500), t.index));
    const heading = [...before.matchAll(/FIA[^.]*?Championship/g)].map((m) => m[0]).pop() ?? null;
    const head = [...t[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => textOf(m[1]).toLowerCase());
    const kind = head.some((h) => /driver/.test(h)) ? 'drivers' : head.some((h) => /manufacturer/.test(h)) ? 'manufacturers' : 'teams';
    const classGuess = heading && /LMGT3/i.test(heading) ? 'lmgt3' : heading && /hypercar/i.test(heading) ? 'hypercar' : i < 2 ? 'hypercar' : 'lmgt3';
    const className = classes.find((c) => c.id === classGuess)?.name ?? classGuess;
    const body = t[0].split(/<tbody[^>]*>/)[1] ?? '';
    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
      .map((r) => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]))
      .filter((cells) => cells.length >= 3)
      .map((cells) => {
        const text = cells.map((c) => textOf(c));
        const numberIx = text.findIndex((x) => /^#\d+/.test(x));
        const nameIx = kind === 'manufacturers' ? 1 : numberIx >= 0 ? numberIx + 1 : 1;
        const makeAlt = cells.slice(0, 3).map((c) => c.match(/alt="([^"]*)"/)?.[1]).find((a) => a && !/^#/.test(a)) ?? null;
        // Driver names arrive SHOUTED ("RENÉ RAST , ROBIN FRIJNS"); teams and
        // manufacturers are left as the source spells them (BMW, TF SPORT).
        const rawName = text[nameIx] ? text[nameIx].replace(/\s*,\s*/g, ', ') : null;
        const displayName = kind === 'drivers' && rawName ? titleCase(rawName) : rawName;
        return standingRow({
          pos: Number(text[0]) || null,
          name: displayName,
          number: numberIx >= 0 ? text[numberIx] : null,
          make: makeAlt ? textOf(makeAlt) : null,
          points: Number(text[text.length - 1]) || 0,
        });
      })
      .filter((r) => r.pos != null);
    standings.push({
      classId: classGuess,
      type: kind,
      name: heading ?? `${className} ${kind[0].toUpperCase()}${kind.slice(1)}' Championship`,
      rows,
    });
  });

  return { classes, events, standings };
}
