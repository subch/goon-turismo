#!/usr/bin/env node
/**
 * Parses a "Submit custom event results" GitHub Issue Form submission and
 * commits the result into data/custom-events/ and data/results/custom.json.
 *
 * Expects these env vars (set by .github/workflows/process-custom-event.yml):
 *   ISSUE_NUMBER, ISSUE_BODY
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadPointsConfig, rankAndScoreResults, parseTimeToMs } from './lib/points.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

function extractField(body, label) {
  // GitHub issue forms render as:
  // ### Label
  //
  // value (possibly multi-line)
  //
  const re = new RegExp(`### ${escapeRegex(label)}\\s*\\n\\n([\\s\\S]*?)(?=\\n### |$)`, 'i');
  const m = body.match(re);
  if (!m) return '';
  const val = m[1].trim();
  return val === '_No response_' ? '' : val;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
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

function parseResultsBlock(block) {
  // "psn: time" per line, time optional (e.g. "friend3: DNF")
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [psnPart, ...rest] = line.split(':');
      const psn = (psnPart || '').trim();
      const timeRaw = rest.join(':').trim();
      const timeMs = parseTimeToMs(timeRaw);
      return { psn, timeRaw: timeRaw || null, timeMs: Number.isNaN(timeMs) ? null : timeMs };
    })
    .filter((r) => r.psn);
}

async function main() {
  const issueNumber = process.env.ISSUE_NUMBER;
  const body = process.env.ISSUE_BODY || '';

  const dgEdgeUrl = extractField(body, 'Official dg-edge event link \\(optional\\)') || extractField(body, 'Official dg-edge event link');
  const eventName = extractField(body, 'Event name');
  const track = extractField(body, 'Track');
  const car = extractField(body, 'Car / class \\(optional\\)') || extractField(body, 'Car / class');
  const eventDate = extractField(body, 'Date \\(YYYY-MM-DD\\)') || extractField(body, 'Date');
  const resultsBlock = extractField(body, 'Results');
  const notes = extractField(body, 'Notes \\(optional\\)') || extractField(body, 'Notes');

  if (!eventName || !resultsBlock) {
    console.error('Missing required fields (event name and/or results) -- aborting.');
    console.error({ eventName, track, eventDate, resultsBlockPresent: !!resultsBlock });
    process.exit(1);
  }

  const pointsConfig = await loadPointsConfig();
  const seasons = await loadJson('seasons.json', []);
  const currentSeasonId = seasons.find((s) => s.current)?.id ?? null;
  const isOfficial = !!dgEdgeUrl;

  let id;
  if (isOfficial) {
    // Reuse the dg-edge numeric event id from the URL (e.g. .../time-trials/630 -> "630")
    // so this lines up with anything the scraper already wrote for the same event.
    const match = dgEdgeUrl.match(/time-trials\/(\d+)/);
    id = match ? match[1] : slugify(dgEdgeUrl);

    const existing = await loadJson(`official-events/${id}.json`, null);
    const eventRecord = existing ?? {
      id,
      source: 'dg-edge',
      seasonId: currentSeasonId,
      dgEdgeUrl,
      track: track || null,
      car: car || null,
      classCode: null,
      startDate: eventDate || null,
      endDate: null,
      status: 'unknown',
      lastScraped: null,
    };
    // Fill in anything the manual submission knows that the scraper hasn't caught yet.
    eventRecord.track = eventRecord.track || track || null;
    eventRecord.car = eventRecord.car || car || null;
    eventRecord.dgEdgeUrl = eventRecord.dgEdgeUrl || dgEdgeUrl;
    await saveJson(`official-events/${id}.json`, eventRecord);

    const index = await loadJson('official-events/index.json', []);
    if (!index.includes(id)) {
      index.push(id);
      await saveJson('official-events/index.json', index);
    }

    const parsedRows = parseResultsBlock(resultsBlock).map((r) => ({ ...r, eventId: id }));
    const allResults = await loadJson('results/official.json', []);
    const others = allResults.filter((r) => r.eventId !== id);
    const scored = rankAndScoreResults(parsedRows, pointsConfig).map((r) => ({ ...r, eventId: id }));
    await saveJson('results/official.json', [...others, ...scored]);

    console.log(`Recorded OFFICIAL event "${eventName}" (${id}) with ${scored.length} result row(s).`);
  } else {
    id = `${eventDate || 'undated'}-${slugify(eventName)}`;

    const eventRecord = {
      id,
      source: 'custom',
      seasonId: currentSeasonId,
      name: eventName,
      track: track || null,
      car: car || null,
      date: eventDate || null,
      createdFromIssue: issueNumber ? Number(issueNumber) : null,
      notes: notes || '',
    };

    await saveJson(`custom-events/${id}.json`, eventRecord);

    const index = await loadJson('custom-events/index.json', []);
    if (!index.includes(id)) {
      index.push(id);
      await saveJson('custom-events/index.json', index);
    }

    const parsedRows = parseResultsBlock(resultsBlock).map((r) => ({ ...r, eventId: id }));
    const allResults = await loadJson('results/custom.json', []);
    const others = allResults.filter((r) => r.eventId !== id);
    const scored = rankAndScoreResults(parsedRows, pointsConfig).map((r) => ({ ...r, eventId: id }));
    await saveJson('results/custom.json', [...others, ...scored]);

    console.log(`Recorded custom event "${eventName}" (${id}) with ${scored.length} result row(s).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
