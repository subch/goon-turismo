#!/usr/bin/env node
/**
 * INTERIM stopgap for scrape-gridstats.mjs (the token-based API script) until
 * we get a GT_GRIDSTATS_TOKEN from the maintainer. Scrapes the same data --
 * driver rating + event history -- from GT-GridStats's public web pages
 * instead of the API.
 *
 * Each tracked friend's page at https://gt-gridstats.com/player/{psn} is a
 * real server-rendered Laravel/Livewire page (confirmed via a live browser +
 * `curl`, 2026-08-16: a plain GET returns the fully populated markup, no JS
 * execution needed) containing:
 *   - Driver Rating: DR / SR letters, Total Entries, Victories, Poles, Other
 *     Points, in a `<div class="bg-white/5 ...">...<span class="text-6xl
 *     ... italic ...">{DR}</span>` / `<span class="text-4xl ... italic
 *     ...">{SR}</span>` pair, plus label/value spans in the blue stats box.
 *   - Event History: a `<h3>Event History</h3>` followed by a table with one
 *     row per GT7 "Lap Time Challenge" / event entry: track, event type,
 *     vehicle, start/end date, global rank, time-or-score. Paginated
 *     (Livewire, 10 rows/page) -- confirmed `?eventPage=N` returns real,
 *     distinct pages server-side, so this fetches every page instead of
 *     just the first (page 1 alone was silently missing most of an active
 *     player's real history).
 * Unknown PSNs 404 cleanly. /player/ is allowed by robots.txt (only /admin,
 * /api, /login etc. are disallowed).
 *
 * Each player's "Event History" is their FULL lifetime history, not just the
 * current season, so this script does two things with it:
 *   1. Current season: always refresh -- create/update every event + result
 *      every run, same as live tracking has always worked.
 *   2. Past seasons: fill gaps only. The spreadsheet-derived historical
 *      seasons are authoritative, but some (summer/spring in particular)
 *      weren't tracked consistently by whoever was filling in the sheet that
 *      week. If GT-GridStats has a result for a (player, track, ~date) that
 *      isn't already recorded from ANY source, add it as a supplemental
 *      'gridstats'-sourced event/result -- but never touch anything already
 *      covered, so the spreadsheet import stays authoritative where it has
 *      data. Track-name matching is fuzzy (case/punctuation-insensitive) with
 *      a few days' date tolerance, since sources format both differently.
 *
 * This event data is a separate, clearly-labeled source ('gridstats') from
 * dg-edge's official-events -- results are merged per-event-id, so this
 * script only ever touches the event ids it scraped this run and leaves
 * dg-edge's entries alone. Once the real GT-GridStats API token is in hand,
 * this script (and its workflow) should be retired in favor of
 * scrape-gridstats.mjs, which returns richer, structured data.
 *
 * Run locally with: npm run scrape:gridstats-web
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { loadPointsConfig, rankAndScoreResults, parseTimeToMs } from './lib/points.mjs';
import { seasonForDate, humanDateToIso } from './lib/seasons.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const BASE = 'https://gt-gridstats.com';
const USER_AGENT =
  'Mozilla/5.0 (compatible; GoonTurismoBot/1.0; +https://goon-turismo.com) - fetches public pages only, on behalf of the goon-turismo.com fan tracker';
const REQUEST_DELAY_MS = 1500; // be polite, this is a free community site -- between players
const PAGE_DELAY_MS = 800; // between pages of the same player's event history
const MAX_EVENT_PAGES = 30; // safety cap, well above any player seen so far (~20 pages)

let warnCount = 0;
function warn(msg) {
  warnCount++;
  console.warn(`WARN: ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeTrack(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function daysBetween(iso1, iso2) {
  return Math.abs((new Date(iso1) - new Date(iso2)) / 86_400_000);
}

const DATE_TOLERANCE_DAYS = 3;

async function fetchPlayerPage(psn, eventPage) {
  const url = eventPage
    ? `${BASE}/player/${encodeURIComponent(psn)}?eventPage=${eventPage}`
    : `${BASE}/player/${encodeURIComponent(psn)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function parseDriverRating($) {
  // "Driver Rating" <p> sits two levels above the DR/SR <span class="italic">
  // trio: p -> div.flex.items-center.justify-between -> div.bg-white/5 (the
  // stat card), which also holds the DR/SR spans as a later sibling div.
  const container = $('p:contains("Driver Rating")').first().parent().parent();
  const letters = container.find('span.italic').map((_, el) => $(el).text().trim()).get();
  // Layout is [DR, "/", SR]; drop the separator.
  const [dr, , sr] = letters;
  return { dr: dr || null, sr: sr || null };
}

function parseStatByLabel($, label) {
  let value = null;
  $('span.block').each((_, el) => {
    if (value) return;
    if ($(el).text().trim().toLowerCase() === label.toLowerCase()) {
      const raw = $(el).next('span').text().trim();
      value = raw ? Number(raw.replace(/,/g, '')) : null;
    }
  });
  return value;
}

function parseEventHistory($, psn) {
  const rows = [];
  $('h3:contains("Event History")')
    .first()
    .parent()
    .find('table tbody tr')
    .each((_, row) => {
      const $row = $(row);
      const cells = $row.find('td');
      if (cells.length < 5) return;

      const track = $(cells[0]).find('span').first().text().trim();
      const eventType = $(cells[0]).find('span').eq(1).text().trim() || null;
      const vehicle = $(cells[1]).text().trim() || null;
      const dateCell = $(cells[2]);
      const startDate =
        dateCell
          .clone()
          .children()
          .remove()
          .end()
          .text()
          .replace(/-+\s*$/, '')
          .trim() || null;
      const endDate = dateCell.find('span').first().text().trim() || null;
      const rankRaw = $(cells[3]).text().trim().replace(/^#/, '').replace(/,/g, '');
      const rank = rankRaw ? Number(rankRaw) : null;
      const timeRaw = $(cells[4]).text().trim() || null;

      if (!track) return;

      rows.push({
        track,
        eventType,
        vehicle,
        startDate,
        endDate,
        globalRank: Number.isNaN(rank) ? null : rank,
        timeRaw,
        timeMs: parseTimeToMs(timeRaw),
        psn,
      });
    });
  return rows;
}

async function scrapePlayer(psn) {
  let html;
  try {
    html = await fetchPlayerPage(psn);
  } catch (err) {
    warn(`Could not fetch GT-GridStats page for "${psn}": ${err.message}`);
    return null;
  }
  if (html === null) {
    warn(`"${psn}" not found on GT-GridStats (404).`);
    return null;
  }

  const $ = cheerio.load(html);
  const { dr, sr } = parseDriverRating($);
  const stats = {
    totalEntries: parseStatByLabel($, 'Total Entries'),
    victories: parseStatByLabel($, 'Victories'),
    poles: parseStatByLabel($, 'Poles'),
    otherPoints: parseStatByLabel($, 'Other Points'),
  };

  // Event History is paginated (Livewire, 10 rows/page, up to ~20 pages for
  // an active player) -- confirmed via `?eventPage=N` returning genuinely
  // different rows per page (2026-08-16). Page 1 alone was silently
  // dropping the vast majority of most players' real history. Keep paging
  // until a page comes back empty (or repeats the previous page verbatim,
  // as a safety net against an unexpected server response).
  const events = parseEventHistory($, psn);
  let previousPageKey = events.map((e) => `${e.track}|${e.startDate}`).join(',');
  for (let page = 2; page <= MAX_EVENT_PAGES; page++) {
    await sleep(PAGE_DELAY_MS);
    let pageHtml;
    try {
      pageHtml = await fetchPlayerPage(psn, page);
    } catch (err) {
      warn(`Could not fetch GT-GridStats event history page ${page} for "${psn}": ${err.message}`);
      break;
    }
    if (!pageHtml) break;
    const $page = cheerio.load(pageHtml);
    const pageEvents = parseEventHistory($page, psn);
    if (pageEvents.length === 0) break;
    const pageKey = pageEvents.map((e) => `${e.track}|${e.startDate}`).join(',');
    if (pageKey === previousPageKey) break; // repeated page -- past the real end
    events.push(...pageEvents);
    previousPageKey = pageKey;
  }

  return { dr, sr, stats, events };
}

async function loadJson(relPath, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA, relPath), 'utf-8'));
  } catch {
    return fallback;
  }
}

async function saveJson(relPath, data) {
  const full = path.join(DATA, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(data, null, 2) + '\n');
}

async function main() {
  const players = await loadJson('players.json', []);
  const pointsConfig = await loadPointsConfig();
  const seasons = await loadJson('seasons.json', []);
  const currentSeason = seasons.find((s) => s.current);
  if (!currentSeason) {
    console.error('No current season found in data/seasons.json -- aborting.');
    process.exit(1);
  }

  const eventIndex = await loadJson('official-events/index.json', []);
  const allResults = await loadJson('results/official.json', []);
  const resultsByEvent = new Map();
  for (const r of allResults) {
    if (!resultsByEvent.has(r.eventId)) resultsByEvent.set(r.eventId, []);
    resultsByEvent.get(r.eventId).push(r);
  }

  // Build a (psn, season, track) -> [dates already recorded] lookup from
  // every existing event, across every source, so past-season backfill only
  // ever fills genuine gaps and never touches/duplicates what's already there.
  const eventById = new Map();
  for (const id of eventIndex) {
    const ev = await loadJson(`official-events/${id}.json`, null);
    if (ev) eventById.set(id, ev);
  }
  const coveredByPsnSeasonTrack = new Map();
  for (const r of allResults) {
    const ev = eventById.get(r.eventId);
    if (!ev?.track || !ev.startDate || !ev.seasonId) continue;
    const key = `${r.psn.toLowerCase()}|${ev.seasonId}|${normalizeTrack(ev.track)}`;
    if (!coveredByPsnSeasonTrack.has(key)) coveredByPsnSeasonTrack.set(key, []);
    coveredByPsnSeasonTrack.get(key).push(ev.startDate);
  }

  const touchedEventIds = new Set();
  let playersUpdated = 0;
  let gapsFilledCount = 0;

  for (const player of players) {
    const scraped = await scrapePlayer(player.psn);
    await sleep(REQUEST_DELAY_MS);
    if (!scraped) continue;
    playersUpdated++;

    player.gridstats = {
      nickname: player.gridstats?.nickname ?? null,
      dr: scraped.dr,
      sr: scraped.sr,
      countryCode: player.gridstats?.countryCode ?? null,
      stats: scraped.stats,
      lastSynced: new Date().toISOString(),
    };

    for (const row of scraped.events) {
      const eventIso = humanDateToIso(row.endDate) ?? humanDateToIso(row.startDate);
      if (!eventIso) continue;
      const season = seasonForDate(eventIso, seasons);
      if (!season) continue; // falls in a gap between tracked seasons

      const isCurrent = season.id === currentSeason.id;
      if (!isCurrent) {
        // Past season: only fill genuine gaps, never overwrite/duplicate
        // what the spreadsheet (or a prior backfill run) already has.
        const key = `${player.psn.toLowerCase()}|${season.id}|${normalizeTrack(row.track)}`;
        const coveredDates = coveredByPsnSeasonTrack.get(key) ?? [];
        const alreadyCovered = coveredDates.some((d) => daysBetween(d, eventIso) <= DATE_TOLERANCE_DAYS);
        if (alreadyCovered) continue;
        gapsFilledCount++;
      }

      const eventId = `gridstats-${slugify(row.track)}-${slugify(row.startDate ?? 'unknown')}`;
      touchedEventIds.add(eventId);

      if (!eventIndex.includes(eventId)) eventIndex.push(eventId);
      await saveJson(`official-events/${eventId}.json`, {
        id: eventId,
        source: 'gridstats',
        seasonId: season.id,
        track: row.track,
        car: row.vehicle,
        classCode: row.eventType,
        startDate: row.startDate,
        endDate: row.endDate,
        status: 'unknown',
        lastScraped: new Date().toISOString(),
      });

      const existing = resultsByEvent.get(eventId) ?? [];
      const withoutThisPlayer = existing.filter((r) => r.psn.toLowerCase() !== player.psn.toLowerCase());
      withoutThisPlayer.push({
        eventId,
        psn: player.psn,
        timeRaw: row.timeMs && !Number.isNaN(row.timeMs) ? row.timeRaw : null,
        timeMs: row.timeMs && !Number.isNaN(row.timeMs) ? row.timeMs : null,
        scrapedAt: new Date().toISOString(),
      });
      resultsByEvent.set(eventId, withoutThisPlayer);
    }
  }

  await saveJson('players.json', players);
  await saveJson('official-events/index.json', eventIndex);

  const finalResults = [];
  for (const [eventId, results] of resultsByEvent) {
    finalResults.push(...rankAndScoreResults(results, pointsConfig).map((r) => ({ ...r, eventId })));
  }
  await saveJson('results/official.json', finalResults);

  console.log(
    `Done. Updated ${playersUpdated}/${players.length} player(s), touched ${touchedEventIds.size} event(s) (${gapsFilledCount} past-season gap(s) filled). ${warnCount} warning(s).`
  );

  if (players.length > 0 && playersUpdated === 0) {
    console.error('Nothing could be scraped at all -- failing the run so it surfaces in Actions.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
