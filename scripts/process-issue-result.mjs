#!/usr/bin/env node
/**
 * Parses a "Submit event results" GitHub Issue Form submission and records
 * it: a custom group event goes to data/custom-events/ + data/results/custom.json;
 * an official GT7 Time Trial goes to data/official-events/ + data/results/official.json,
 * attached to the sync's record of that Time Trial when there is one (matched
 * on track + date by the shared rule in lib/seasons.mjs) and created as a
 * `manual` event otherwise, so the next sync picks it up rather than
 * duplicating it.
 *
 * Expects these env vars (set by .github/workflows/process-custom-event.yml):
 *   ISSUE_NUMBER, ISSUE_BODY
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadPointsConfig, rankAndScoreResults, parseTimeToMs } from './lib/points.mjs';
import { findMatchingEvent, officialEventId, seasonForDate, slugify, canonicalEvent } from './lib/seasons.mjs';

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

async function loadOfficialEvents() {
  const dir = path.join(DATA, 'official-events');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const events = [];
  for (const f of files) events.push(JSON.parse(await readFile(path.join(dir, f), 'utf-8')));
  return events;
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

function scored(rows, eventId, pointsConfig) {
  return rankAndScoreResults(rows, pointsConfig).map((r) => ({
    eventId,
    psn: r.psn,
    timeRaw: r.timeRaw,
    timeMs: r.timeMs,
    groupRank: r.groupRank,
    points: r.points,
  }));
}

async function main() {
  const issueNumber = process.env.ISSUE_NUMBER;
  const body = process.env.ISSUE_BODY || '';

  const officialAnswer = extractField(body, 'Official GT7 Time Trial\\?');
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    console.error(`Date must be YYYY-MM-DD, got "${eventDate}" -- aborting.`);
    process.exit(1);
  }

  const pointsConfig = await loadPointsConfig();
  const seasons = await loadJson('seasons.json', []);
  const currentSeasonId = seasons.find((s) => s.current)?.id ?? null;
  const isOfficial = /^yes/i.test(officialAnswer);
  const parsedRows = parseResultsBlock(resultsBlock);

  if (isOfficial) {
    if (!track) {
      console.error('An official Time Trial needs its track -- aborting.');
      process.exit(1);
    }
    const events = await loadOfficialEvents();
    // Rule 2: the same TT if the track matches and the given date is within
    // tolerance of the record's start or end.
    let event = findMatchingEvent(events, { track, startDate: eventDate, endDate: eventDate });
    if (event) {
      event.car ??= car || null;
      console.log(`Matched existing Time Trial ${event.id} ("${event.track}", ${event.startDate}..${event.endDate}).`);
    } else {
      // Rule 1: season by end date. With only one date known it stands for both.
      event = {
        id: officialEventId(track, eventDate),
        source: 'manual',
        seasonId: seasonForDate(eventDate, seasons)?.id ?? currentSeasonId,
        track,
        car: car || null,
        classCode: null,
        startDate: eventDate,
        endDate: eventDate,
      };
      console.log(`No synced record of this Time Trial yet -- creating ${event.id}.`);
    }
    await saveJson(`official-events/${event.id}.json`, canonicalEvent(event));

    // Submitted rows replace that player's row for this event; everyone else's stays.
    const allResults = await loadJson('results/official.json', []);
    const submittedPsns = new Set(parsedRows.map((r) => r.psn.toLowerCase()));
    const kept = allResults.filter((r) => r.eventId === event.id && !submittedPsns.has(r.psn.toLowerCase()));
    const others = allResults.filter((r) => r.eventId !== event.id);
    const merged = [...others, ...scored([...kept, ...parsedRows], event.id, pointsConfig)];
    merged.sort((a, b) => a.eventId.localeCompare(b.eventId) || (a.groupRank ?? 999) - (b.groupRank ?? 999) || a.psn.localeCompare(b.psn));
    await saveJson('results/official.json', merged);
    console.log(`Recorded ${parsedRows.length} result row(s) for official Time Trial ${event.id}.`);
  } else {
    const id = `${eventDate}-${slugify(eventName)}`;
    const eventRecord = {
      id,
      source: 'custom',
      seasonId: seasonForDate(eventDate, seasons)?.id ?? currentSeasonId,
      name: eventName,
      track: track || null,
      car: car || null,
      date: eventDate,
      createdFromIssue: issueNumber ? Number(issueNumber) : null,
      notes: notes || '',
    };
    await saveJson(`custom-events/${id}.json`, eventRecord);

    const index = await loadJson('custom-events/index.json', []);
    if (!index.includes(id)) {
      index.push(id);
      await saveJson('custom-events/index.json', index);
    }

    const allResults = await loadJson('results/custom.json', []);
    const others = allResults.filter((r) => r.eventId !== id);
    await saveJson('results/custom.json', [...others, ...scored(parsedRows, id, pointsConfig)]);
    console.log(`Recorded custom event "${eventName}" (${id}) with ${parsedRows.length} result row(s).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
