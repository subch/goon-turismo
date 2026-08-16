#!/usr/bin/env node
/**
 * Pulls per-player GT7 stats from the GT-GridStats public API
 * (https://gt-gridstats.com/api-docs) for everyone in data/players.json.
 *
 * This is a much better data source than scraping dg-edge.com's website:
 * it's a real documented API keyed purely by PSN (no login required per
 * player), returning DR/SR and stats for up to 16 drivers per request.
 *
 * Requires a GT_GRIDSTATS_TOKEN environment variable (see README for how to
 * get one -- it's not self-serve, you have to ask the maintainer). Until
 * that secret is set, this script logs a clear message and exits 0 (does
 * NOT fail the workflow) so the rest of the pipeline keeps working.
 *
 * Run locally with: GT_GRIDSTATS_TOKEN=xxx npm run scrape:gridstats
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const API_BASE = 'https://gt-gridstats.com/api';
const BATCH_SIZE = 16; // API max per request
const BATCH_DELAY_MS = 4000; // stay well under the 10 req/min metered limit

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
  return res.json();
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
    let data;
    try {
      data = await fetchRacers(batch, token);
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

    if (i < batches.length - 1) await sleep(BATCH_DELAY_MS);
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
