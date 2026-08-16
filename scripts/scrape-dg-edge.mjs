#!/usr/bin/env node
/**
 * Pulls public Gran Turismo 7 Time Trial data from dg-edge.com for the friends
 * tracked in data/players.json, and updates:
 *   - data/players.json            (per-player aggregate stats)
 *   - data/official-events/*.json  (one file per official time trial event)
 *   - data/official-events/index.json
 *   - data/results/official.json   (group results per event, ranked + scored)
 *
 * Selectors below were re-verified against the real dg-edge.com markup via a
 * live browser session on 2026-08-16 -- the site had been redesigned since
 * this script was first written, which caused two real bugs that were
 * silently writing garbage into official-events/ (fixed 2026-08-16):
 *   - The events-listing page's pagination controls
 *     (/events/time-trials/page-N?...) matched the same link selector as
 *     real event pages and were being scraped as if they were events.
 *   - Track/car label text ("Track", "Car") no longer exists on event
 *     detail pages at all -- extractStatByLabel() was matching unrelated
 *     filter-widget text instead ("Car typeAll modelsSportGR.1GR.2...").
 *     Track/car/date/tire now come from real, stable selectors instead
 *     (`.event-title h2 a` / `h3`, `.main-specified-car .card-body`,
 *     `.event-date`, `.tire`).
 *
 * Player aggregate stats (Edge Score, Global position, etc.) are unaffected
 * by the redesign -- still plain labeled text, matched case-insensitively.
 *
 * IMPORTANT KNOWN LIMITATION (re-confirmed 2026-08-16): event detail pages
 * no longer show a per-player leaderboard/ranking table at all (just
 * aggregate stats -- total players, time-to-top-100/1000, medal-time
 * thresholds) -- confirmed absent, not just hard to reach. So this script
 * cannot pull any individual friend's time for an official event; expect
 * official-event results to come entirely through the manual submission
 * flow instead (see .github/ISSUE_TEMPLATE/custom-event-result.yml, which
 * supports optionally linking a submission to a dg-edge event). If dg-edge
 * brings a real leaderboard/lookup-by-player feature back, this script
 * should be extended to use it.
 *
 * Run locally with: npm run scrape:dg-edge
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

const BASE = 'https://www.dg-edge.com';
const USER_AGENT =
  'Mozilla/5.0 (compatible; GoonTurismoBot/1.0; +https://goon-turismo.com) - fetches public pages only, on behalf of the goon-turismo.com fan tracker';
const REQUEST_DELAY_MS = 1200; // be polite, this is a shared community site

let warnCount = 0;
function warn(msg) {
  warnCount++;
  console.warn(`WARN: ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Find a stat by its visible label text (e.g. "Global position", "Events
 * attended") anywhere on the page, and return the nearest plausible value
 * string. Case-insensitive since dg-edge uppercases labels via CSS while the
 * actual DOM text is mixed-case (confirmed: "Global position", "Avg. delta").
 */
function extractStatByLabel($, label) {
  const target = label.trim().toLowerCase();
  let value = null;
  $('*').each((_, el) => {
    if (value) return;
    const $el = $(el);
    // Only look at leaf-ish nodes to avoid matching huge parent containers.
    if ($el.children().length > 2) return;
    const text = $el.text().trim();
    if (text.toLowerCase() === target) {
      // Try siblings first, then parent's next sibling, then parent text minus label.
      const sibText = $el.next().text().trim();
      if (sibText) {
        value = sibText;
        return;
      }
      const parent = $el.parent();
      const parentText = parent.text().replace(new RegExp(label, 'i'), '').trim();
      if (parentText) {
        value = parentText;
      }
    }
  });
  return value;
}

function parseNumberish(str) {
  if (!str) return null;
  const m = String(str).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

async function scrapePlayer(psn) {
  const url = `${BASE}/players/${encodeURIComponent(psn)}`;
  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    warn(`Could not fetch player page for "${psn}": ${err.message}`);
    return null;
  }
  const $ = cheerio.load(html);

  const stats = {
    edgeScore: parseNumberish(extractStatByLabel($, 'Edge score')),
    globalPosition: parseNumberish(extractStatByLabel($, 'Global position')),
    countryPosition: parseNumberish(extractStatByLabel($, 'Country position')),
    eventsAttended: parseNumberish(extractStatByLabel($, 'Events attended')),
    avgDelta: extractStatByLabel($, 'Avg. delta') ?? extractStatByLabel($, 'Average delta'),
    lastScraped: new Date().toISOString(),
  };

  const gotAnything = Object.values(stats).some((v) => v !== null && v !== undefined);
  if (!gotAnything) {
    warn(
      `Fetched ${url} but couldn't match any known stat labels. dg-edge's markup may differ from what this script expects -- open the page and compare visible labels to the ones in extractStatByLabel() calls in scripts/scrape-dg-edge.mjs.`
    );
  }

  return stats;
}

/**
 * Find event detail links on the time trials listing page.
 */
async function listActiveEvents() {
  const url = `${BASE}/events/time-trials`;
  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    warn(`Could not fetch events list page: ${err.message}`);
    return [];
  }
  const $ = cheerio.load(html);

  const links = new Set();
  $('a[href*="/events/time-trials/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href === '/events/time-trials' || href.endsWith('/time-trials')) return;
    // Pagination controls on the listing page match this same selector
    // (/events/time-trials/page-N?trackId=...) -- not real events.
    if (/\/time-trials\/page-\d+/.test(href)) return;
    links.add(new URL(href, BASE).toString());
  });

  if (links.size === 0) {
    warn(
      'Found no event detail links on /events/time-trials. The listing may be rendered client-side (JS), in which case this script will need to switch to a headless-browser fetch instead of a plain HTML GET.'
    );
  }

  return [...links];
}

function slugFromUrl(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return parts[parts.length - 1] || url;
}

async function scrapeEventDetail(url) {
  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    warn(`Could not fetch event page ${url}: ${err.message}`);
    return null;
  }
  const $ = cheerio.load(html);
  const pageText = $('body').text();

  // Real current markup (verified live, 2026-08-16):
  //   <div class="event-title">
  //     <h1>Time Trial</h1>
  //     <h2><a href="/database/tracks/...">{track base name}</a></h2>
  //     <h3>{track layout variant}</h3>  (not always present)
  //   </div>
  //   <div class="card main-specified-car">
  //     <div class="card-body"><small>{make}</small><br> {model}</div>
  //   </div>
  //   <div class="event-date">{start date} - {end date}</div>
  //   <span class="tire">{tire code}</span>
  const trackBase = $('.event-title h2 a').first().text().trim() || null;
  const trackVariant = $('.event-title h3').first().text().trim() || null;
  const track = trackBase
    ? trackVariant
      ? `${trackBase} - ${trackVariant}`
      : trackBase
    : $('h1').first().text().trim() || null;

  const carBody = $('.main-specified-car .card-body').first();
  const carMake = carBody.find('small').first().text().trim();
  const carModel = carBody.clone().find('small').remove().end().text().trim();
  const car = carMake || carModel ? [carMake, carModel].filter(Boolean).join(' ') : null;

  const dateRangeText = $('.event-date').first().text().trim();
  const [startDate, endDate] = dateRangeText.split(/\s*-\s*/).map((s) => s.trim());

  const event = {
    id: slugFromUrl(url),
    source: 'dg-edge',
    dgEdgeUrl: url,
    track,
    car,
    classCode: $('.tire').first().text().trim() || null,
    startDate: startDate || null,
    endDate: endDate || null,
    status: /\blive\b/i.test(pageText) ? 'live' : 'unknown',
    lastScraped: new Date().toISOString(),
  };

  // No per-player leaderboard exists on event detail pages anymore (see
  // module doc comment) -- confirmed absent, not just hard to reach.
  // Official-event results come entirely through manual submission now.
  return { event, results: [] };
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

  // 1. Per-player aggregate stats.
  for (const player of players) {
    const stats = await scrapePlayer(player.psn);
    if (stats) {
      player.stats = { ...player.stats, ...stats };
    }
    await sleep(REQUEST_DELAY_MS);
  }
  await saveJson('players.json', players);

  // 2. Active/listed events + per-event results for tracked friends.
  const eventUrls = await listActiveEvents();
  const eventIndex = await loadJson('official-events/index.json', []);
  const allResults = await loadJson('results/official.json', []);
  const resultsByEvent = new Map();
  for (const r of allResults) {
    if (!resultsByEvent.has(r.eventId)) resultsByEvent.set(r.eventId, []);
    resultsByEvent.get(r.eventId).push(r);
  }

  for (const url of eventUrls) {
    const scraped = await scrapeEventDetail(url);
    await sleep(REQUEST_DELAY_MS);
    if (!scraped) continue;
    const { event, results } = scraped;

    const eventIso = humanDateToIso(event.endDate) ?? humanDateToIso(event.startDate);
    const season = eventIso ? seasonForDate(eventIso, seasons) : null;
    if (season) event.seasonId = season.id;
    else warn(`Could not match event "${event.id}" (${event.track ?? 'unknown track'}) to a tracked season -- date: ${event.startDate ?? 'unknown'}`);

    await saveJson(`official-events/${event.id}.json`, event);
    if (!eventIndex.includes(event.id)) {
      eventIndex.push(event.id);
    }

    if (results.length > 0) {
      resultsByEvent.set(event.id, results);
    }
  }

  await saveJson('official-events/index.json', eventIndex);

  // 3. Re-rank + re-score every event's results (group-relative, not dg-edge global rank).
  const finalResults = [];
  for (const [eventId, results] of resultsByEvent) {
    finalResults.push(...rankAndScoreResults(results, pointsConfig).map((r) => ({ ...r, eventId })));
  }
  await saveJson('results/official.json', finalResults);

  console.log(
    `Done. Scraped ${players.length} player(s), ${eventUrls.length} event page(s), ${finalResults.length} result row(s). ${warnCount} warning(s).`
  );

  // Don't fail the whole Action for partial scraping misses -- only fail hard
  // if literally everything failed (e.g. dg-edge is down or fully blocked us).
  if (players.length > 0 && eventUrls.length === 0 && finalResults.length === 0 && warnCount >= players.length) {
    console.error('Nothing could be scraped at all -- failing the run so it surfaces in Actions.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
