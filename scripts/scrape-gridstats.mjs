#!/usr/bin/env node
/**
 * Pulls per-player GT7 stats (DR/SR + a richer stats block) from the real,
 * documented GT-GridStats API (https://gt-gridstats.com/api-docs) for
 * everyone in data/players.json, via GET /api/racers/{identifiers}.
 *
 * Confirmed against the live API docs and this account's actual dev-portal
 * quota card: the account this token belongs to is capped at 5 requests/day
 * (not the 1000/day shown as an example in the generic docs page) plus
 * 10 req/min. With 24 players and a batch size of 16, one full sync costs
 * exactly 2 requests -- keep it that way. Do NOT lower BATCH_SIZE (it would
 * raise the number of requests per run) and do not add retry loops here;
 * a single failed batch should just be skipped and logged, not retried.
 *
 * This only replaces the *player DR/SR/stats* portion of the pipeline. It
 * does not know about events or results at all -- the real API has no
 * event-listing or per-event-leaderboard endpoint, so scrape-gridstats-web.mjs
 * (and its event/results gap-filling) keeps running independently in the
 * same nightly workflow, after this script.
 *
 * Requires a GT_GRIDSTATS_TOKEN environment variable (already set as a
 * GitHub Actions secret). Until that secret is set, this script logs a
 * clear message and exits 0 (does NOT fail the workflow) so the rest of the
 * pipeline keeps working.
 *
 * Run locally with: GT_GRIDSTATS_TOKEN=xxx npm run scrape:gridstats
 * (careful running this manually more than once or twice a day -- it counts
 * against the same 5/day quota as the nightly job.)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const API_BASE = 'https://gt-gridstats.com/api';
const BATCH_SIZE = 16; // API max per request -- also minimizes request count against the 5/day quota
const BATCH_DELAY_MS = 6500; // stay under the 10 req/min metered limit with margin

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchRacers(psns, token) {
  const url = `${API_BASE}/racers/${psns.map(encodeURIComponent).join(',')}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (res.status === 429) {
    throw new Error('Rate limited (429) by GT-GridStats -- reduce batch frequency or wait.');
  }
  if (!res.ok) {
    throw new Error(`GT-GridStats API error: ${res.status} ${res.statusText}`);
  }
  const quotaLimit = res.headers.get('x-quota-limit');
  const quotaRemaining = res.headers.get('x-quota-remaining');
  if (quotaRemaining !== null) {
    console.log(`GT-GridStats quota: ${quotaRemaining}/${quotaLimit ?? '?'} remaining today`);
  }
  return { body: await res.json(), quotaRemaining: quotaRemaining !== null ? Number(quotaRemaining) : null };
}

async function main() {
  const token = process.env.GT_GRIDSTATS_TOKEN;
  if (!token) {
    console.log(
      'GT_GRIDSTATS_TOKEN is not set -- skipping GT-GridStats sync. Add it as a GitHub Actions secret once you have a token (see README).'
    );
    return;
  }

  const playersPath = path.join(DATA, 'players.json');
  const players = JSON.parse(await readFile(playersPath, 'utf-8'));
  const byPsnLower = new Map(players.map((p) => [p.psn.toLowerCase(), p]));

  const batches = chunk(players.map((p) => p.psn), BATCH_SIZE);
  const notFoundAll = [];

  for (const [i, batch] of batches.entries()) {
    console.log(`Fetching batch ${i + 1}/${batches.length}: ${batch.join(', ')}`);
    let data, quotaRemaining;
    try {
      ({ body: data, quotaRemaining } = await fetchRacers(batch, token));
    } catch (err) {
      console.error(`WARN: batch ${i + 1} failed: ${err.message}`);
      continue;
    }

    for (const driver of data.drivers || []) {
      const psnKey = (driver.PSN_ID || driver.psn || driver.Nickname || '').toLowerCase();
      const player = byPsnLower.get(psnKey);
      if (!player) continue;
      player.gridstats = {
        nickname: driver.Nickname ?? null,
        dr: driver.DR ?? null,
        sr: driver.SR ?? null,
        countryCode: driver.country_code ?? null,
        stats: driver.stats ?? null,
        lastSynced: new Date().toISOString(),
      };
    }
    if (data.not_found?.length) notFoundAll.push(...data.not_found);

    const batchesLeft = batches.length - 1 - i;
    if (batchesLeft === 0) break;
    if (quotaRemaining !== null && quotaRemaining < batchesLeft) {
      console.warn(
        `WARN: only ${quotaRemaining} request(s) left in today's quota but ${batchesLeft} batch(es) remain -- stopping early to avoid a 429.`
      );
      break;
    }
    await sleep(BATCH_DELAY_MS);
  }

  await writeFile(playersPath, JSON.stringify(players, null, 2) + '\n');

  console.log(`Done. Updated ${players.length - notFoundAll.length} of ${players.length} player(s).`);
  if (notFoundAll.length) {
    console.warn(`WARN: not found on GT-GridStats: ${notFoundAll.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
