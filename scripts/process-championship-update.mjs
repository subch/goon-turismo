#!/usr/bin/env node
/**
 * Parses an "Update championship standings" GitHub Issue Form submission and
 * records one round's results into data/championships/<season-id>.json.
 * Expects ISSUE_NUMBER and ISSUE_BODY env vars.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

function extractField(body, label) {
  const re = new RegExp(`### ${escapeRegex(label)}\\s*\\n\\n([\\s\\S]*?)(?=\\n### |$)`, 'i');
  const m = body.match(re);
  if (!m) return '';
  const val = m[1].trim();
  return val === '_No response_' ? '' : val;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
  const body = process.env.ISSUE_BODY || '';

  const seasonId = extractField(body, 'Season id');
  const roundId = extractField(body, 'Round id');
  const resultsBlock = extractField(body, 'Results');

  if (!seasonId || !roundId || !resultsBlock) {
    console.error('Missing required fields (season id, round id, and/or results) -- aborting.');
    process.exit(1);
  }

  const seasonPath = path.join(DATA, 'championships', `${seasonId}.json`);
  let season;
  try {
    season = JSON.parse(await readFile(seasonPath, 'utf-8'));
  } catch (err) {
    console.error(`Could not find/parse data/championships/${seasonId}.json: ${err.message}`);
    process.exit(1);
  }

  const round = season.rounds.find((r) => r.id === roundId);
  if (!round) {
    console.error(`Round "${roundId}" not found in season "${seasonId}". Known rounds: ${season.rounds.map((r) => r.id).join(', ')}`);
    process.exit(1);
  }

  const lines = resultsBlock
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let updatedCount = 0;
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const teamName = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();
    const [placeRaw, poleFlRaw, pointsRaw] = rest.split(',').map((s) => s.trim());

    const team = season.teams.find((t) => t.name.toLowerCase() === teamName.toLowerCase());
    if (!team) {
      console.warn(`WARN: no team named "${teamName}" in season "${seasonId}" -- skipping that line.`);
      continue;
    }

    const place = placeRaw ? parseInt(placeRaw, 10) : null;
    const poleFl = poleFlRaw ? parseInt(poleFlRaw, 10) : 0;
    const points = pointsRaw ? parseInt(pointsRaw, 10) : 0;

    team.results = team.results || {};
    team.results[roundId] = { place: Number.isNaN(place) ? null : place, poleFl: Number.isNaN(poleFl) ? 0 : poleFl, points: Number.isNaN(points) ? 0 : points };
    updatedCount += 1;
  }

  // Recompute each team's total from its per-round results.
  for (const team of season.teams) {
    team.totalPoints = Object.values(team.results || {}).reduce((sum, r) => sum + (r.points || 0), 0);
  }

  await writeFile(seasonPath, JSON.stringify(season, null, 2) + '\n');
  console.log(`Updated ${updatedCount} team(s) for round "${roundId}" of season "${seasonId}".`);

  if (updatedCount === 0) {
    console.error('No team lines matched -- treating as a failure so it surfaces in Actions.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
