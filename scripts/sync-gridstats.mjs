#!/usr/bin/env node
/**
 * THE one GT7 data sync. Pulls everything the site knows about the crew's
 * official Time Trials from GT-GridStats (https://gt-gridstats.com), the only
 * source since 2026-09-28 (dg-edge.com was retired: it had stopped showing
 * per-player times a year earlier and only ever contributed event listings).
 *
 * Two phases, two kinds of access:
 *
 *   1. Player snapshots -- the documented token API, GET /api/racers/{psn,...}
 *      (max 16 per request; https://gt-gridstats.com/api-docs). DR/SR, nickname,
 *      country and the stats block (total races, wins, poles, fastest laps,
 *      clean races, licence...). Metered at 10 requests/min and a daily quota
 *      that the response reports in X-Quota-Limit / X-Quota-Remaining. The
 *      quota was 5/day when this pipeline was built and is 100/day as of
 *      2026-09-28 (read off a live response), so this runs on every sync: two
 *      requests per run, eight a day. If the quota ever shrinks again the
 *      headers say so, and the remaining count is written to sync-status.json.
 *      No token -> this phase is skipped with a warning; nothing else breaks.
 *
 *   2. Time Trial results -- the public, server-rendered player pages at
 *      /player/{psn} (Livewire, `?eventPage=N` paginates, 10 rows/page, newest
 *      first; /player/ is allowed by robots.txt). The API has no event-listing
 *      or per-event-leaderboard endpoint (re-checked against the docs
 *      2026-09-28), so this is still the only way to get times. Each row is a
 *      track, event type, car, start/end date, global rank and time.
 *
 * What is written (only when content actually changed, so a quiet run makes
 * no commit):
 *   data/players.json               gridstats block per player
 *   data/official-events/<id>.json  one file per Time Trial (see lib/seasons.mjs
 *                                   for the id scheme and the two rules)
 *   data/results/official.json      every result, ranked and scored per event
 *   data/sync-status.json           when this last ran and what it saw
 *
 * Scope: rows whose Time Trial ends in the CURRENT season, plus anything that
 * ended in the last RECENT_DAYS (so a TT closing across a season boundary is
 * still finished off). Older rows are ignored on purpose: closed seasons are
 * the spreadsheet's, and the "gap-fill past seasons from GT-GridStats" feature
 * this replaces duplicated ~150 spreadsheet events and double-counted their
 * points before anyone noticed. A new crew member's back catalogue for the
 * current season is picked up on their first sync; their history in closed
 * seasons is not, by design.
 *
 * Run locally: GT_GRIDSTATS_TOKEN=xxx npm run sync:gridstats   (token optional)
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { loadPointsConfig, rankAndScoreResults, parseTimeToMs } from './lib/points.mjs';
import { seasonForDate, humanDateToIso, toIso, findMatchingEvent, officialEventId, canonicalEvent, seasonIsDerived } from './lib/seasons.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const EVENTS_DIR = path.join(DATA, 'official-events');

const BASE = 'https://gt-gridstats.com';
const USER_AGENT =
  'Mozilla/5.0 (compatible; GoonTurismoBot/1.0; +https://goon-turismo.com) - on behalf of the goon-turismo.com fan tracker';

const API_BATCH_SIZE = 16; // documented maximum per request
const API_BATCH_DELAY_MS = 6500; // 10 req/min metered limit, with margin
const PLAYER_DELAY_MS = 1500; // between players -- a free community site, be polite
const PAGE_DELAY_MS = 800; // between pages of one player's history
const MAX_EVENT_PAGES = 30; // safety cap; the recency cut-off normally stops paging after 1-3 pages
const RECENT_DAYS = 21;

let warnCount = 0;
function warn(msg) {
  warnCount++;
  console.warn(`WARN: ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadJson(relPath, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA, relPath), 'utf-8'));
  } catch {
    return fallback;
  }
}

/** Write only if the serialised content differs, so unchanged files stay untouched in git. */
async function saveJsonIfChanged(relPath, data) {
  const full = path.join(DATA, relPath);
  const next = JSON.stringify(data, null, 2) + '\n';
  let prev = null;
  try {
    prev = await readFile(full, 'utf-8');
  } catch {}
  if (prev === next) return false;
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, next);
  return true;
}

async function loadEvents() {
  const files = (await readdir(EVENTS_DIR)).filter((f) => f.endsWith('.json'));
  const events = [];
  for (const f of files) events.push(JSON.parse(await readFile(path.join(EVENTS_DIR, f), 'utf-8')));
  return events;
}

// ---------------------------------------------------------------------------
// Phase 1: player snapshots from the token API
// ---------------------------------------------------------------------------
async function fetchRacers(psns, token) {
  const url = `${BASE}/api/racers/${psns.map(encodeURIComponent).join(',')}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
  });
  const quota = { limit: res.headers.get('x-quota-limit'), remaining: res.headers.get('x-quota-remaining') };
  if (res.status === 429) throw Object.assign(new Error('quota or rate limit exceeded (429)'), { quota });
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText}`), { quota });
  return { body: await res.json(), quota };
}

async function syncPlayerSnapshots(players, token, status) {
  if (!token) {
    warn('GT_GRIDSTATS_TOKEN is not set -- skipping the player snapshot phase (DR/SR/stats keep their last values).');
    status.api = { ran: false, reason: 'no token' };
    return;
  }
  const byPsnLower = new Map(players.map((p) => [p.psn.toLowerCase(), p]));
  const psns = players.map((p) => p.psn);
  const batches = [];
  for (let i = 0; i < psns.length; i += API_BATCH_SIZE) batches.push(psns.slice(i, i + API_BATCH_SIZE));

  status.api = { ran: true, requests: 0, updated: 0, notFound: [], quota: null, errors: [] };
  for (const [i, batch] of batches.entries()) {
    if (i > 0) await sleep(API_BATCH_DELAY_MS);
    let body, quota;
    try {
      ({ body, quota } = await fetchRacers(batch, token));
    } catch (err) {
      warn(`API batch ${i + 1}/${batches.length} failed: ${err.message}`);
      status.api.errors.push(err.message);
      if (err.quota?.remaining != null) status.api.quota = err.quota;
      continue;
    }
    status.api.requests++;
    status.api.quota = quota;
    for (const driver of body.drivers ?? []) {
      const player = byPsnLower.get(String(driver.PSN_ID ?? '').toLowerCase());
      if (!player) continue;
      player.gridstats = {
        nickname: driver.Nickname ?? null,
        dr: driver.DR ?? null,
        sr: driver.SR ?? null,
        countryCode: driver.country_code ?? null,
        stats: driver.stats ?? null,
      };
      status.api.updated++;
    }
    if (body.not_found?.length) status.api.notFound.push(...body.not_found);
  }
  if (status.api.notFound.length) warn(`not on GT-GridStats: ${status.api.notFound.join(', ')}`);
  if (status.api.quota?.remaining != null) {
    console.log(`GT-GridStats API quota: ${status.api.quota.remaining}/${status.api.quota.limit} left today`);
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Time Trial results from the public player pages
// ---------------------------------------------------------------------------
async function fetchPlayerPage(psn, eventPage) {
  const url = `${BASE}/player/${encodeURIComponent(psn)}${eventPage > 1 ? `?eventPage=${eventPage}` : ''}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Rows of the "Event History" table (markup re-verified 2026-09-28):
 *   td0: <span>{track}</span><span>{event type, e.g. Lap Time Challenge}</span>
 *   td1: {vehicle}
 *   td2: {start} - <span>{end}</span>          ("24 Sep 2026")
 *   td3: #{global rank}
 *   td4: {time or score}
 */
function parseEventHistory($) {
  const rows = [];
  $('h3:contains("Event History")')
    .first()
    .parent()
    .find('table tbody tr')
    .each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 5) return;
      const track = $(cells[0]).find('span').first().text().trim();
      if (!track) return;
      const dateCell = $(cells[2]);
      const startDate = dateCell.clone().children().remove().end().text().replace(/-+\s*$/, '').trim() || null;
      const endDate = dateCell.find('span').first().text().trim() || null;
      const timeRaw = $(cells[4]).text().trim() || null;
      const timeMs = parseTimeToMs(timeRaw);
      rows.push({
        track,
        eventType: $(cells[0]).find('span').eq(1).text().trim() || null,
        vehicle: $(cells[1]).text().trim() || null,
        startIso: humanDateToIso(startDate),
        endIso: humanDateToIso(endDate) ?? humanDateToIso(startDate),
        timeRaw,
        timeMs: Number.isNaN(timeMs) ? null : timeMs,
      });
    });
  return rows;
}

/** Every history row for a player that ends on/after cutoffIso. Stops paging
 * as soon as a whole page is older than that (rows are newest first).
 * Returns null when the player is not on GT-GridStats at all. */
async function scrapeRecentRows(psn, cutoffIso) {
  const rows = [];
  let previousKey = null;
  for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
    if (page > 1) await sleep(PAGE_DELAY_MS);
    const html = await fetchPlayerPage(psn, page);
    if (html === null) return page === 1 ? null : rows;
    const pageRows = parseEventHistory(cheerio.load(html));
    if (pageRows.length === 0) break;
    const key = pageRows.map((r) => `${r.track}|${r.startIso}`).join(',');
    if (key === previousKey) break; // server repeated the last page: past the real end
    previousKey = key;
    const recent = pageRows.filter((r) => r.endIso && r.endIso >= cutoffIso);
    rows.push(...recent);
    if (recent.length < pageRows.length) break; // the rest of the history is older
  }
  return rows;
}

// ---------------------------------------------------------------------------
async function main() {
  const startedAt = new Date().toISOString();
  const players = await loadJson('players.json', []);
  const seasons = await loadJson('seasons.json', []);
  const pointsConfig = await loadPointsConfig();
  const currentSeason = seasons.find((s) => s.current);
  if (!currentSeason) {
    console.error('No current season in data/seasons.json -- aborting.');
    process.exit(1);
  }
  const events = await loadEvents();
  const eventById = new Map(events.map((e) => [e.id, e]));
  const allResults = await loadJson('results/official.json', []);
  const resultsByEvent = new Map();
  for (const r of allResults) {
    if (!resultsByEvent.has(r.eventId)) resultsByEvent.set(r.eventId, []);
    resultsByEvent.get(r.eventId).push(r);
  }

  const status = { startedAt, finishedAt: null, api: null, pages: null };

  // --- phase 1 -------------------------------------------------------------
  await syncPlayerSnapshots(players, process.env.GT_GRIDSTATS_TOKEN, status);

  // --- phase 2 -------------------------------------------------------------
  const recentCutoff = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const cutoffIso = currentSeason.startDate < recentCutoff ? currentSeason.startDate : recentCutoff;
  console.log(`Current season ${currentSeason.id}; taking Time Trials that end on/after ${cutoffIso}`);

  const touchedEventIds = new Set();
  const newEventIds = [];
  let playersScraped = 0;
  const unseasoned = new Set();

  for (const player of players) {
    let rows;
    try {
      rows = await scrapeRecentRows(player.psn, cutoffIso);
    } catch (err) {
      warn(`could not read GT-GridStats history for "${player.psn}": ${err.message}`);
      await sleep(PLAYER_DELAY_MS);
      continue;
    }
    await sleep(PLAYER_DELAY_MS);
    if (rows === null) {
      warn(`"${player.psn}" is not on GT-GridStats (404).`);
      continue;
    }
    playersScraped++;

    for (const row of rows) {
      if (!row.startIso) continue;
      const season = seasonForDate(row.endIso, seasons); // rule 1
      if (!season) {
        unseasoned.add(`${row.track} (${row.startIso} - ${row.endIso})`);
        continue;
      }
      const candidate = { track: row.track, startDate: row.startIso, endDate: row.endIso };
      let event = findMatchingEvent(events, candidate); // rule 2
      if (event) {
        // Fill only what is missing; never overwrite what another record
        // (the spreadsheet, an earlier sync, a manual submission) already has.
        event.car ??= row.vehicle;
        event.classCode ??= row.eventType;
      } else {
        event = {
          id: officialEventId(row.track, row.startIso),
          source: 'gridstats',
          seasonId: season.id,
          track: row.track,
          car: row.vehicle,
          classCode: row.eventType,
          startDate: row.startIso,
          endDate: row.endIso,
        };
        if (eventById.has(event.id)) {
          warn(`id collision for ${event.id} -- skipping the row rather than overwriting`);
          continue;
        }
        events.push(event);
        eventById.set(event.id, event);
        newEventIds.push(event.id);
      }
      touchedEventIds.add(event.id);

      const rest = (resultsByEvent.get(event.id) ?? []).filter((r) => r.psn.toLowerCase() !== player.psn.toLowerCase());
      rest.push({ eventId: event.id, psn: player.psn, timeRaw: row.timeRaw, timeMs: row.timeMs });
      resultsByEvent.set(event.id, rest);
    }
  }
  for (const u of unseasoned) warn(`Time Trial falls outside every season in seasons.json: ${u}`);

  // --- phase 3: keep rule 1 true for every event seasons.json governs ------
  // The season an event scores in is a function of its end date and
  // seasons.json, so when a season is closed and the next one opened, a TT
  // that ends in the new season moves over on the next run. Spreadsheet
  // events before 2026 keep their tab's season (see seasonIsDerived).
  const eventsWritten = [];
  for (const ev of events) {
    if (seasonIsDerived(ev)) {
      const season = seasonForDate(toIso(ev.endDate) ?? toIso(ev.startDate), seasons);
      if (season && season.id !== ev.seasonId) {
        console.log(`season of ${ev.id}: ${ev.seasonId} -> ${season.id} (ends ${ev.endDate})`);
        ev.seasonId = season.id;
      }
    }
    if (await saveJsonIfChanged(`official-events/${ev.id}.json`, canonicalEvent(ev))) eventsWritten.push(ev.id);
  }

  // Re-rank and re-score every event's results (group-relative, not global
  // rank) and write them in a stable order so the diff is readable.
  const finalResults = [];
  for (const [eventId, rows] of resultsByEvent) {
    finalResults.push(
      ...rankAndScoreResults(rows, pointsConfig).map((r) => ({
        eventId,
        psn: r.psn,
        timeRaw: r.timeRaw,
        timeMs: r.timeMs,
        groupRank: r.groupRank,
        points: r.points,
      }))
    );
  }
  finalResults.sort(
    (a, b) => a.eventId.localeCompare(b.eventId) || (a.groupRank ?? 999) - (b.groupRank ?? 999) || a.psn.localeCompare(b.psn)
  );
  const resultsChanged = await saveJsonIfChanged('results/official.json', finalResults);
  const playersChanged = await saveJsonIfChanged('players.json', players);

  status.finishedAt = new Date().toISOString();
  status.pages = {
    playersScraped,
    playersTotal: players.length,
    eventsTouched: touchedEventIds.size,
    eventsCreated: newEventIds,
    cutoffIso,
    warnings: warnCount,
  };
  await saveJsonIfChanged('sync-status.json', status);

  console.log(
    `Done. API updated ${status.api?.updated ?? 0} player(s); pages read for ${playersScraped}/${players.length}; ` +
      `${touchedEventIds.size} event(s) touched, ${newEventIds.length} new (${newEventIds.join(', ') || 'none'}); ` +
      `${eventsWritten.length} event file(s) written, results ${resultsChanged ? 'changed' : 'unchanged'}, players ${playersChanged ? 'changed' : 'unchanged'}. ${warnCount} warning(s).`
  );

  // Partial misses are warnings. Only fail the run when GT-GridStats gave us
  // nothing at all, so it shows up red instead of quietly publishing a stale site.
  if (players.length > 0 && playersScraped === 0) {
    console.error('Nothing could be read from GT-GridStats at all -- failing the run so it surfaces.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
