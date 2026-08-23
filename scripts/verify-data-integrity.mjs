#!/usr/bin/env node
/**
 * Standing data-integrity check, run as the last step of every scrape
 * workflow (after data is committed and pushed, so a failure here never
 * blocks or loses a scrape -- it just turns the Actions run red so someone
 * notices). Exists because every real duplicate-events incident so far
 * (2026-08 x2) went unnoticed for days: the scrapers ran successfully every
 * night, quietly reintroducing the same class of bug, and nobody found out
 * until a crew member spotted it on the live site. This catches that
 * category of problem the same day it happens instead.
 *
 * Checks:
 *   1. No duplicate events -- same (season, fuzzy track name, ~3-day date)
 *      tracked under more than one event id. Reuses the exact matching
 *      logic the scrapers use to prevent duplicates, so this check can
 *      never be stricter or looser than what actually created the data.
 *   2. Every result references an event id that actually exists.
 *   3. Every event references a season id that actually exists in
 *      seasons.json.
 *
 * Run locally with: npm run verify:data
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeTrack, toIso } from './lib/seasons.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const DATE_TOLERANCE_DAYS = 3;

async function loadJson(relPath, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA, relPath), 'utf-8'));
  } catch {
    return fallback;
  }
}

async function loadAllEvents() {
  const dir = path.join(DATA, 'official-events');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  const events = [];
  for (const f of files) {
    const ev = JSON.parse(await readFile(path.join(dir, f), 'utf-8'));
    events.push(ev);
  }
  return events;
}

function findDuplicateClusters(events) {
  const groups = new Map();
  for (const ev of events) {
    if (!ev.seasonId || !ev.track) continue;
    const iso = toIso(ev.startDate);
    if (!iso) continue;
    const key = `${ev.seasonId}|${normalizeTrack(ev.track)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...ev, iso });
  }

  const clusters = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.iso.localeCompare(b.iso));
    const built = [];
    for (const ev of sorted) {
      let placed = false;
      for (const cluster of built) {
        const last = cluster[cluster.length - 1];
        const days = Math.abs((new Date(last.iso) - new Date(ev.iso)) / 86_400_000);
        if (days <= DATE_TOLERANCE_DAYS) {
          cluster.push(ev);
          placed = true;
          break;
        }
      }
      if (!placed) built.push([ev]);
    }
    for (const cluster of built) {
      if (cluster.length >= 2) clusters.push(cluster);
    }
  }
  return clusters;
}

async function main() {
  const events = await loadAllEvents();
  const results = await loadJson('results/official.json', []);
  const seasons = await loadJson('seasons.json', []);
  const seasonIds = new Set(seasons.map((s) => s.id));
  const eventIds = new Set(events.map((e) => e.id));

  let failed = false;

  const duplicateClusters = findDuplicateClusters(events);
  if (duplicateClusters.length > 0) {
    failed = true;
    console.error(`FAIL: ${duplicateClusters.length} duplicate event cluster(s) found:`);
    for (const cluster of duplicateClusters) {
      console.error(`  - ${cluster.map((e) => `${e.id} (${e.source}, "${e.track}", ${e.startDate})`).join('  <->  ')}`);
    }
  } else {
    console.log(`OK: no duplicate events (${events.length} checked).`);
  }

  const orphanedResults = results.filter((r) => !eventIds.has(r.eventId));
  if (orphanedResults.length > 0) {
    failed = true;
    console.error(`FAIL: ${orphanedResults.length} result(s) reference a non-existent event id:`);
    for (const r of orphanedResults.slice(0, 20)) {
      console.error(`  - psn=${r.psn} eventId=${r.eventId}`);
    }
  } else {
    console.log(`OK: no orphaned results (${results.length} checked).`);
  }

  const badSeasonEvents = events.filter((e) => e.seasonId && !seasonIds.has(e.seasonId));
  if (badSeasonEvents.length > 0) {
    failed = true;
    console.error(`FAIL: ${badSeasonEvents.length} event(s) reference a non-existent season id:`);
    for (const e of badSeasonEvents.slice(0, 20)) {
      console.error(`  - id=${e.id} seasonId=${e.seasonId}`);
    }
  } else {
    console.log(`OK: every event's seasonId is a real season.`);
  }

  if (failed) {
    console.error('\nData integrity check FAILED -- see above.');
    process.exit(1);
  }
  console.log('\nAll data integrity checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
