#!/usr/bin/env node
/**
 * Pulls public Gran Turismo 7 Time Trial data from dg-edge.com for the friends
 * tracked in data/players.json, and updates:
 *   - data/players.json            (per-player aggregate stats)
 *   - data/official-events/*.json  (one file per official time trial event)
 *   - data/official-events/index.json
 *   - data/results/official.json   (group results per event, ranked + scored)
 *
 * This is intentionally defensive: dg-edge.com's markup was not available to
 * inspect directly when this was written (no live browser access at build
 * time), so extraction is done by matching on *visible label text* rather
 * than guessing CSS class names. That's more resilient to styling/markup
 * changes, but it does mean this script logs WARN lines instead of crashing
 * when it can't find something -- check the GitHub Action log after the
 * first few scheduled runs and adjust the selectors/labels below as needed.
 *
 * Run locally with: npm run scrape:dg-edge
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { loadPointsConfig, rankAndScoreResults, parseTimeToMs } from './lib/points.mjs';

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
 * Find a stat by its visible label text (e.g. "Edge Score", "Events Attended")
 * anywhere on the page, and return the nearest plausible value string.
 */
function extractStatByLabel($, label) {
  let value = null;
  $('*').each((_, el) => {
    if (value) return;
    const $el = $(el);
    // Only look at leaf-ish nodes to avoid matching huge parent containers.
    if ($el.children().length > 2) return;
    const text = $el.text().trim();
    if (text === label) {
      // Try siblings first, then parent's next sibling, then parent text minus label.
      const sibText = $el.next().text().trim();
      if (sibText) {
        value = sibText;
        return;
      }
      const parent = $el.parent();
      const parentText = parent.text().replace(label, '').trim();
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
    edgeScore: parseNumberish(extractStatByLabel($, 'Edge Score')),
    globalPosition: parseNumberish(extractStatByLabel($, 'Global Position')),
    countryPosition: parseNumberish(extractStatByLabel($, 'Country Position')),
    eventsAttended: parseNumberish(extractStatByLabel($, 'Events Attended')),
    avgDelta: extractStatByLabel($, 'Average Delta') ?? extractStatByLabel($, 'Avg Δ'),
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
    if (href && href !== '/events/time-trials' && !href.endsWith('/time-trials')) {
      links.add(new URL(href, BASE).toString());
    }
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

async function scrapeEventDetail(url, players) {
  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    warn(`Could not fetch event page ${url}: ${err.message}`);
    return null;
  }
  const $ = cheerio.load(html);
  const pageText = $('body').text();

  const event = {
    id: slugFromUrl(url),
    source: 'dg-edge',
    dgEdgeUrl: url,
    track: extractStatByLabel($, 'Track') || $('h1').first().text().trim() || null,
    car: extractStatByLabel($, 'Car') || null,
    classCode: (pageText.match(/\b(SH|SS|RS|RM|RH|SM)\b/) || [])[1] || null,
    startDate: null,
    endDate: null,
    status: /\blive\b/i.test(pageText) ? 'live' : 'unknown',
    lastScraped: new Date().toISOString(),
  };

  // Date range like "Aug 1, 2026 - Aug 29, 2026"
  const dateRange = pageText.match(
    /([A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4})\s*[-–]\s*([A-Z][a-z]{2}\s+\d{1,2},?\s+\d{4})/
  );
  if (dateRange) {
    event.startDate = dateRange[1];
    event.endDate = dateRange[2];
  }

  // Look for each tracked friend's PSN anywhere in the page and try to pull a
  // nearby lap-time-shaped string out of the same row/container.
  const results = [];
  for (const player of players) {
    const psnRegex = new RegExp(psnPattern(player.psn), 'i');
    $('*').each((_, el) => {
      const $el = $(el);
      if ($el.children().length > 4) return; // skip big containers, want row-level nodes
      const text = $el.text();
      if (!psnRegex.test(text)) return;
      const timeMatch = text.match(/\b\d{1,2}:\d{2}\.\d{3}\b|\b\d{1,3}\.\d{3}\b/);
      if (timeMatch) {
        results.push({
          eventId: event.id,
          psn: player.psn,
          timeRaw: timeMatch[0],
          timeMs: parseTimeToMs(timeMatch[0]),
          scrapedAt: new Date().toISOString(),
        });
      }
    });
  }

  return { event, results };
}

function psnPattern(psn) {
  return psn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    const scraped = await scrapeEventDetail(url, players);
    await sleep(REQUEST_DELAY_MS);
    if (!scraped) continue;
    const { event, results } = scraped;

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
