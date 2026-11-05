#!/usr/bin/env node
/**
 * Standing data-integrity check, run as the last step of every sync (after
 * the data is committed, pushed and published, so a failure here never blocks
 * or loses a sync -- it turns the run red so someone notices). Every real data
 * incident so far went unnoticed for days or weeks while the syncs ran
 * "successfully": two duplicate-event bugs in 2026-08, and the end-date /
 * start-date mix-up that duplicated most of the spreadsheet history and
 * double-counted its points until 2026-09-28. This is the tripwire for that
 * whole category.
 *
 * Checks (the rules themselves live in lib/seasons.mjs, shared with the code
 * that writes the data, so this can never drift from it):
 *   1. No two events are the same Time Trial (rule 2: matching track and
 *      start OR end date within tolerance), in any season.
 *   2. Every event's seasonId is the season its end date falls in (rule 1),
 *      except spreadsheet-imported events from before 2026, whose tab decides
 *      (seasons.mjs, SEASONS_JSON_DECIDES_FROM).
 *   3. Every result references an existing event; every event references an
 *      existing season; no event has an unknown source or a non-ISO date;
 *      nothing left over from the retired dg-edge pipeline.
 *   4. No player appears twice in one event's results.
 *   5. Goon TTs (data/goon-tt/): every lap is a roster PSN with its proof
 *      screenshot on file, set inside the window; the tune, if named,
 *      exists; opensAt/closesAt are midnight and 23:59 Central on
 *      startDate/endDate.
 *
 * Run locally with: npm run verify:data
 */
import { readFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sameTimeTrial, seasonForEvent, seasonIsDerived, toIso } from './lib/seasons.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const KNOWN_SOURCES = new Set(['gridstats', 'historical', 'manual']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

async function loadJson(relPath, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA, relPath), 'utf-8'));
  } catch {
    return fallback;
  }
}

async function loadAllEvents() {
  const dir = path.join(DATA, 'official-events');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const events = [];
  for (const f of files) {
    const ev = JSON.parse(await readFile(path.join(dir, f), 'utf-8'));
    if (ev.id !== f.replace(/\.json$/, '')) events.push({ ...ev, _fileMismatch: f });
    else events.push(ev);
  }
  return events;
}

async function main() {
  const events = await loadAllEvents();
  const results = await loadJson('results/official.json', []);
  const seasons = await loadJson('seasons.json', []);
  const seasonIds = new Set(seasons.map((s) => s.id));
  const eventIds = new Set(events.map((e) => e.id));
  const failures = [];
  const fail = (msg) => failures.push(msg);

  // 1. duplicates
  const dupes = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      if (sameTimeTrial(events[i], events[j])) dupes.push([events[i], events[j]]);
    }
  }
  if (dupes.length) {
    fail(`${dupes.length} pair(s) of events are the same Time Trial:`);
    for (const [a, b] of dupes) fail(`  - ${a.id} ("${a.track}", ${a.startDate}..${a.endDate})  <->  ${b.id} ("${b.track}", ${b.startDate}..${b.endDate})`);
  } else console.log(`OK: no duplicate Time Trials (${events.length} events checked).`);

  // 2. season rule
  const wrongSeason = events.filter((e) => seasonIsDerived(e) && seasonForEvent(e, seasons)?.id !== e.seasonId);
  if (wrongSeason.length) {
    fail(`${wrongSeason.length} event(s) are filed under a season other than the one they end in:`);
    for (const e of wrongSeason) fail(`  - ${e.id}: seasonId=${e.seasonId}, ends ${e.endDate} (${seasonForEvent(e, seasons)?.id ?? 'no season'})`);
  } else console.log('OK: every event seasons.json governs is filed in the season it ends in.');

  // 3. references, shapes, leftovers
  const orphaned = results.filter((r) => !eventIds.has(r.eventId));
  if (orphaned.length) {
    fail(`${orphaned.length} result(s) reference a non-existent event:`);
    for (const r of orphaned.slice(0, 20)) fail(`  - psn=${r.psn} eventId=${r.eventId}`);
  } else console.log(`OK: no orphaned results (${results.length} checked).`);

  const badSeason = events.filter((e) => !e.seasonId || !seasonIds.has(e.seasonId));
  if (badSeason.length) {
    fail(`${badSeason.length} event(s) have no valid seasonId:`);
    for (const e of badSeason.slice(0, 20)) fail(`  - ${e.id} seasonId=${e.seasonId}`);
  } else console.log("OK: every event's seasonId is a real season.");

  const badShape = events.filter(
    (e) =>
      !KNOWN_SOURCES.has(e.source) ||
      !e.track ||
      !ISO_RE.test(e.startDate ?? '') ||
      !ISO_RE.test(e.endDate ?? '') ||
      toIso(e.startDate) > toIso(e.endDate) ||
      e._fileMismatch ||
      'dgEdgeUrl' in e ||
      'lastScraped' in e ||
      'status' in e
  );
  if (badShape.length) {
    fail(`${badShape.length} event(s) have an unexpected shape (unknown source, missing track, non-ISO or inverted dates, dg-edge leftovers, file name != id):`);
    for (const e of badShape.slice(0, 20)) fail(`  - ${e._fileMismatch ?? e.id}: ${JSON.stringify(e)}`);
  } else console.log('OK: every event has a known source, a track and ISO dates.');

  const players = await loadJson('players.json', []);
  const playerLeftovers = players.filter((p) => 'stats' in p || 'dgEdgeUrl' in p);
  if (playerLeftovers.length) fail(`${playerLeftovers.length} player(s) still carry dg-edge fields: ${playerLeftovers.map((p) => p.psn).join(', ')}`);
  else console.log('OK: players.json carries no dg-edge fields.');

  // 4. one row per player per event
  const seen = new Set();
  const doubled = [];
  for (const r of results) {
    const key = `${r.eventId}|${r.psn.toLowerCase()}`;
    if (seen.has(key)) doubled.push(key);
    seen.add(key);
  }
  if (doubled.length) {
    fail(`${doubled.length} (event, player) pair(s) have more than one result row:`);
    for (const k of doubled.slice(0, 20)) fail(`  - ${k}`);
  } else console.log('OK: one result per player per event.');

  // 5. Goon TTs
  const goonTtProblems = await checkGoonTts();
  if (goonTtProblems.length) {
    fail(`${goonTtProblems.length} problem(s) in data/goon-tt/:`);
    for (const p of goonTtProblems) fail(`  - ${p}`);
  } else console.log('OK: every Goon TT lap has a roster driver, its proof and a date in the window.');

  if (failures.length) {
    console.error('\nData integrity check FAILED:');
    for (const f of failures) console.error(`FAIL: ${f}`);
    process.exit(1);
  }
  console.log('\nAll data integrity checks passed.');
}

/** The Central-time date and HH:MM of an instant. */
function central(iso) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

async function checkGoonTts() {
  const dir = path.join(DATA, 'goon-tt');
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
  const roster = new Set((await loadJson('players.json', [])).map((p) => p.psn));
  const tunes = new Set((await readdir(path.join(DATA, 'tunes')).catch(() => [])).map((f) => f.replace(/\.json$/, '')));
  const problems = [];
  for (const file of files) {
    const tt = JSON.parse(await readFile(path.join(dir, file), 'utf-8'));
    const at = tt.id ?? file;
    if (`${tt.id}.json` !== file) problems.push(`${file}: id is "${tt.id}"`);
    if (!ISO_RE.test(tt.startDate) || !ISO_RE.test(tt.endDate) || tt.startDate > tt.endDate) problems.push(`${at}: bad startDate/endDate`);
    if (typeof tt.pp !== 'number' || !tt.car || !tt.tyres) problems.push(`${at}: needs car, pp and tyres`);
    if (tt.tuneId && !tunes.has(tt.tuneId)) problems.push(`${at}: no tune "${tt.tuneId}"`);
    const opens = central(tt.opensAt);
    const closes = central(tt.closesAt);
    if (opens.date !== tt.startDate || opens.time !== '00:00') problems.push(`${at}: opensAt is ${opens.date} ${opens.time} Central, not midnight on ${tt.startDate}`);
    if (closes.date !== tt.endDate || closes.time !== '23:59') problems.push(`${at}: closesAt is ${closes.date} ${closes.time} Central, not 23:59 on ${tt.endDate}`);
    for (const lap of tt.laps ?? []) {
      const which = `${at}: ${lap.psn}'s ${lap.timeMs} ms lap`;
      if (!roster.has(lap.psn)) problems.push(`${which} is not by a roster PSN`);
      if (!Number.isInteger(lap.timeMs) || lap.timeMs <= 0) problems.push(`${which} has no lap time`);
      if (!ISO_RE.test(lap.setOn) || lap.setOn < tt.startDate || lap.setOn > tt.endDate) problems.push(`${which} was set ${lap.setOn}, outside the window`);
      if (!['hand', 'command', 'message'].includes(lap.via)) problems.push(`${which} has an unknown via "${lap.via}"`);
      if (!lap.proof?.startsWith(`/goon-tt/${tt.id}/`)) problems.push(`${which} has no proof under /goon-tt/${tt.id}/`);
      else await access(path.join(ROOT, 'public', lap.proof)).catch(() => problems.push(`${which}: proof ${lap.proof} is missing`));
    }
  }
  return problems;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
