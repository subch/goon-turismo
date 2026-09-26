// World Rally Championship via the results feed behind wrc.com. The site is
// built on Red Bull's platform and its Results & Standings pages read JSON
// from p-p.redbull.com/rb-wrccom-lintegration-yv-prod/api/ (found by
// watching what the page loads; no key, no login). Overall classification
// per rally plus the championship tables; stage-by-stage times are left to
// the official page, which each event links to.
//
// Shape notes: seasons.json lists WRC and ERC seasons; season-detail gives
// the rounds; events/{id}.json names the main rally and its id; results.json
// is keyed by entryId with ISO-8601 durations ("PT2H57M8.2S") next to the ms
// values we actually use; entries.json turns entryIds into crews.
import { getJson } from '../lib/http.mjs';
import { eventStatus, sessionStatus, result, standingRow, formatMs } from '../lib/schema.mjs';

const BASE = 'https://p-p.redbull.com/rb-wrccom-lintegration-yv-prod/api';
const DELAY = 400;

export const id = 'wrc';
export const name = 'World Rally Championship';
export const shortName = 'WRC';
export const tier = 'other';
export const source = { name: 'wrc.com results', url: 'https://www.wrc.com/en/results-and-standings' };
export const classes = [{ id: 'wrc', name: 'WRC' }];

// Championship tables to show, matched on the feed's championship names.
const STANDINGS = [
  { match: /^FIA World Rally Championship for Drivers$/, type: 'drivers', name: "Drivers' Championship" },
  { match: /^FIA World Rally Championship for Manufacturers$/, type: 'manufacturers', name: "Manufacturers' Championship" },
  { match: /^FIA WRC2 Championship for Drivers$/, type: 'drivers', name: "WRC2 Drivers' Championship" },
];

function fmtGap(ms) {
  if (ms == null || ms === 0) return null;
  const s = formatMs(ms);
  return `+${s.replace(/^0:/, '')}`;
}

// "+02:00" style offset from the feed's minutes -> ISO start at 00:00 local.
function localMidnightIso(date, offsetMinutes) {
  if (!date) return null;
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes ?? 0);
  return `${date}T00:00:00${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function crewName(e) {
  const d = e.driver ? `${e.driver.firstName} ${titleLast(e.driver.lastName)}` : null;
  const c = e.codriver ? `${e.codriver.firstName} ${titleLast(e.codriver.lastName)}` : null;
  return [d, c].filter(Boolean).join(' / ') || null;
}

function titleLast(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (m, p, ch) => p + ch.toUpperCase());
}

export async function fetchSeason({ season, previous, full, log }) {
  const seasons = await getJson(`${BASE}/seasons.json`, { delayMs: DELAY });
  const s = seasons.find((x) => x.year === season && /^World Rally/i.test(x.name));
  if (!s) throw new Error(`WRC: no World Rally Championship season ${season} in the feed`);
  const detail = await getJson(`${BASE}/season-detail.json?seasonId=${s.seasonId}`, { delayMs: DELAY });
  const rounds = (detail.seasonRounds ?? [])
    .map((r) => r.event)
    .filter(Boolean)
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  log?.(`WRC ${season}: ${rounds.length} rounds`);

  const prevEvents = new Map((previous?.events ?? []).map((e) => [e.id, e]));
  const events = [];
  for (const [i, ev] of rounds.entries()) {
    const eventId = String(ev.slug || ev.eventId).replace(/^\d+-wrc-/, '');
    const prev = prevEvents.get(eventId);
    if (prev?.complete && !full) {
      events.push({ ...prev, round: i + 1 });
      continue;
    }
    const status = eventStatus(ev.startDate, ev.finishDate);
    const startUtc = localMidnightIso(ev.startDate, ev.timeZoneOffset);
    let results = null;
    if (status !== 'upcoming') {
      log?.(`  ${ev.name}`);
      const evDetail = await getJson(`${BASE}/events/${ev.eventId}.json`, { delayMs: DELAY });
      const rally = (evDetail.rallies ?? []).find((r) => r.isMain) ?? evDetail.rallies?.[0];
      if (rally) {
        const [entries, rows] = await Promise.all([
          getJson(`${BASE}/events/${ev.eventId}/rallies/${rally.rallyId}/entries.json`, { delayMs: DELAY }),
          getJson(`${BASE}/events/${ev.eventId}/rallies/${rally.rallyId}/results.json`, { delayMs: DELAY }),
        ]);
        const byEntry = new Map(entries.map((e) => [e.entryId, e]));
        results = rows
          .sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
          .map((r) => {
            const e = byEntry.get(r.entryId) ?? {};
            return result({
              pos: r.position ?? null,
              number: e.identifier ?? null,
              name: crewName(e),
              team: e.entrant?.name ?? null,
              make: e.vehicleModel ?? e.manufacturer?.name ?? null,
              cls: e.eligibility && e.eligibility !== 'M' ? e.eligibility.replace(/\s*\(.*\)$/, '') : e.group?.name ?? null,
              time: r.totalTimeMs ? formatMs(r.totalTimeMs) : null,
              gap: r.position === 1 ? null : fmtGap(r.diffFirstMs),
              interval: r.position === 1 ? null : fmtGap(r.diffPrevMs),
              status: r.penaltyTimeMs ? `+${formatMs(r.penaltyTimeMs).replace(/^0:/, '')} penalty` : null,
            });
          });
        if (!results.length) results = null;
      }
    }
    events.push({
      id: eventId,
      round: i + 1,
      name: ev.name,
      shortName: ev.name.replace(/^(Rally|Rallye)\s+(de\s+|del\s+|di\s+)?/i, ''),
      circuit: null,
      location: ev.location ?? null,
      country: ev.country?.name ?? null,
      dateStart: ev.startDate,
      dateEnd: ev.finishDate,
      status,
      officialUrl: 'https://www.wrc.com/en/results-and-standings',
      complete: status === 'finished' && !!results,
      sessions: [
        {
          id: `${eventId}-overall`,
          classId: 'wrc',
          type: 'race',
          name: 'Overall classification',
          startUtc,
          endUtc: null,
          status: sessionStatus(startUtc, null, status === 'finished' ? 'FINISHED' : null, !!results),
          results,
        },
      ],
    });
  }

  log?.(`WRC ${season}: standings`);
  const champs = detail.championships ?? [];
  const standings = [];
  for (const want of STANDINGS) {
    const c = champs.find((x) => want.match.test(x.name));
    if (!c) continue;
    const [cd, overall] = await Promise.all([
      getJson(`${BASE}/championship-detail.json?championshipId=${c.championshipId}&seasonId=${s.seasonId}`, { delayMs: DELAY }),
      getJson(`${BASE}/championship-overall-results.json?championshipId=${c.championshipId}&seasonId=${s.seasonId}`, { delayMs: DELAY }),
    ]);
    const entries = new Map((cd.championshipEntries ?? []).map((e) => [e.championshipEntryId, e]));
    const rows = (overall.entryResults ?? [])
      .sort((a, b) => (a.overallPosition ?? 999) - (b.overallPosition ?? 999))
      .map((r) => {
        const e = entries.get(r.championshipEntryId) ?? {};
        const isPerson = !!e.personId;
        return standingRow({
          pos: r.overallPosition ?? null,
          name: isPerson ? `${e.fieldOne ?? ''} ${titleLast(e.fieldTwo ?? '')}`.trim() : e.fieldOne ?? e.fieldTwo ?? null,
          team: isPerson ? e.fieldFive ?? null : null,
          make: isPerson ? e.fieldFour ?? null : null,
          points: r.overallPoints ?? null,
          wins: (r.roundResults ?? []).filter((x) => x.position === '1').length,
        });
      });
    standings.push({ classId: 'wrc', type: want.type, name: want.name, rows });
  }

  return { classes, events, standings };
}
