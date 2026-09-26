#!/usr/bin/env node
/**
 * Syncs the real-world racing results pages (/racing/) -- schedule, session
 * classifications and championship standings for every series registered in
 * scripts/racing/series/index.mjs -- into data/racing/<series>/<season>.json.
 *
 *   npm run scrape:racing                      every series, current season
 *   npm run scrape:racing -- --series f1,wec   just those
 *   npm run scrape:racing -- --season 2025     a past season
 *   npm run scrape:racing -- --full            refetch events already complete
 *
 * Each adapter gets the previous file back so it can skip events it has
 * already finished with; `--full` turns that off (use after fixing a parser).
 *
 * One broken source must not take the others down: an adapter that throws is
 * logged as a WARN and its previous file is left untouched, and the run still
 * exits 0 so the VPS sync goes on to commit, build and publish whatever did
 * work. It only exits 1 when *every* adapter failed, which is the "the box
 * has no network" case, not the "one site redesigned" case. A stale series is
 * visible on the page itself: every series card shows when it last synced.
 *
 * Shrink guard, same idea as sync.sh's: a source that answers 200 with an
 * empty list is the likeliest failure mode, and it would otherwise publish a
 * season with no rounds. A new file with fewer than half the previous file's
 * events is refused unless RACING_ALLOW_SHRINK=1.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SERIES, tierOf } from './racing/series/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'racing');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const full = args.includes('--full');
const season = Number(flag('season')) || new Date().getUTCFullYear();
const only = flag('series')?.split(',').map((s) => s.trim().toLowerCase());

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function readPrevious(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

let ok = 0;
let failed = 0;
for (const series of SERIES) {
  if (only && !only.includes(series.id)) continue;
  const dir = path.join(OUT, series.id);
  const file = path.join(dir, `${season}.json`);
  const previous = await readPrevious(file);
  const started = Date.now();
  try {
    const got = await series.fetchSeason({ season, previous, full, log });
    const events = got.events ?? [];
    if (previous?.events?.length > 2 && events.length < previous.events.length / 2 && process.env.RACING_ALLOW_SHRINK !== '1') {
      throw new Error(
        `refusing to write ${events.length} events over the ${previous.events.length} already on file (set RACING_ALLOW_SHRINK=1 if the season really shrank)`,
      );
    }
    const out = {
      series: series.id,
      name: series.name,
      shortName: series.shortName,
      tier: tierOf(series),
      season,
      seasonLabel: got.seasonLabel ?? undefined,
      syncedAt: new Date().toISOString(),
      source: series.source,
      classes: got.classes ?? series.classes ?? [],
      events,
      standings: got.standings ?? [],
    };
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(out, null, 2) + '\n');
    const sessions = events.reduce((n, e) => n + e.sessions.length, 0);
    const withResults = events.reduce((n, e) => n + e.sessions.filter((s) => s.results).length, 0);
    log(`${series.shortName} ${season}: wrote ${events.length} events, ${withResults}/${sessions} sessions with results, ${out.standings.length} standings tables (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    ok++;
  } catch (err) {
    failed++;
    console.warn(`WARN: ${series.shortName} ${season} sync failed, previous file left as-is: ${err.message}`);
  }
}

if (ok === 0 && failed > 0) {
  console.error('every series failed');
  process.exit(1);
}
