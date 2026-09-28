import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rankAndScoreResults, loadPointsConfig } from './lib/points.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// One-time historical backfill from the crew's old scoring spreadsheet
// (https://docs.google.com/spreadsheets/d/1NCanDSx8Wn9lWtl-VkYLdrmaxVh5p_dUaUiKCNgJNa8),
// which the site's ongoing per-event data now fully replaces (see README).
// Safe to re-run: it regenerates every historical (source: "historical")
// event/result from the sheet and no-ops on anything from a live source, with
// two things preserved from what is already on disk (since the 2026-09-28
// clean-up merged the GT-GridStats copies of these events into them): the
// event's real Time Trial window, GT7 track name and car, and any result row
// for a player the sheet never had. seasons.json is hand-maintained and is
// not touched. Each tab uses a
// slightly different column layout (place+points+Driver vs. just totalpoints+Driver
// vs. place+totalpoints+Driver), so columns are located dynamically from the header
// row rather than assumed at fixed indices.
const SHEET_ID = '1NCanDSx8Wn9lWtl-VkYLdrmaxVh5p_dUaUiKCNgJNa8';
const SEASON_META = {
  'spring-2026': { name: 'Spring 2026', year: 2026, gid: '1973624700' },
  'winter-2026': { name: 'Winter 2026', year: 2026, gid: '1161277607' },
  'autumn-2025': { name: 'Autumn 2025', year: 2025, gid: '1809616587' },
  'summer-2025': { name: 'Summer 2025', year: 2025, gid: '124032855' },
  'spring-2025': { name: 'Spring 2025', year: 2025, gid: '1077551781' },
  'winter-2025': { name: 'Winter 2025', year: 2025, gid: '1487195374' },
  'autumn-2024': { name: 'Autumn 2024', year: 2024, gid: '1522118410' },
  'summer-2024': { name: 'Summer 2024', year: 2024, gid: '854918856' },
  'spring-2024': { name: 'Spring 2024', year: 2024, gid: '1415291113' },
  'winter-2024': { name: 'Winter 2024', year: 2024, gid: '2094723709' },
  y2023: { name: '2023', year: 2023, gid: '805057064' },
};

// One known bad data point: Sinderby's recorded time of "1000" (seconds) for
// Monza in Winter 2024 is a physically impossible lap time (real times for
// that event cluster ~98-104s) and the sheet itself zeroed Sinderby's score
// for it rather than treating it as a real fastest lap -- exclude it so it
// doesn't corrupt the rest of that event's group-relative scoring.
const EXCLUDED_ROWS = new Set(['winter-2024__Monza__2/7__Sinderby']);

function parseCsv(text) {
  // RFC4180-ish parser: handles quoted fields with embedded commas (e.g. "1,234").
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

async function fetchSeasonRows(gid) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return parseCsv(await res.text());
}

function parseSeasonTab(rows) {
  // Header row layout varies between tabs (place+points+Driver vs. just
  // total-points+Driver vs. place+total-points+Driver), so columns are
  // located dynamically instead of assumed at fixed indices.
  const headerRowIdx = rows.findIndex((r) => r.includes('Driver'));
  if (headerRowIdx === -1) throw new Error('no header row with "Driver" found');
  const headerRow = rows[headerRowIdx];
  const driverCol = headerRow.indexOf('Driver');

  // Circuit/Car/Last Day/Top Time always sit exactly 4 rows above the header.
  const circuitRow = rows[headerRowIdx - 4];
  const carRow = rows[headerRowIdx - 3];
  const dateRow = rows[headerRowIdx - 2];

  const eventCols = [];
  for (let i = driverCol + 1; i < headerRow.length; i++) {
    if (headerRow[i] === 'time') eventCols.push(i);
  }
  const events = eventCols
    .map((i) => ({ col: i, circuit: circuitRow[i] || null, car: carRow[i] || null, date: dateRow[i] || null }))
    .filter((e) => e.circuit);

  const players = [];
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const driver = (row[driverCol] || '').trim();
    if (!driver) continue;
    const perEvent = events
      .map((e) => ({ circuit: e.circuit, date: e.date, car: e.car, time: row[e.col] || null }))
      .filter((x) => x.time);
    players.push({ driver, perEvent });
  }

  return { events, players };
}

// Sheet display name -> tracked PSN. Confirmed mappings per the site's own
// records (README/players.json); guessed matches noted; alumni (never on
// the current 15-player roster, no verifiable PSN) get a slugified id and
// are added to players.json as inactive/historical-only.
const NAME_TO_PSN = {
  'C. Rackhaed': 'craigrackhaed', // confirmed ("Crockhaed" match)
  'Dr K': 'bravemen84', // confirmed
  Ashy_Wenises: 'ashy_wenises',
  Fairfax: 'ainsliespeed', // confirmed
  Empire: 'empire_of_ravens',
  Superfarts: 'superpharts', // sheet nickname vs. tracked PSN spelling
  Sinderby: 'sinder_22',
  rickiep00h: 'rickiep00h',
  Rammy: 'dog_nougat', // confirmed
  'Rammy McRamface': 'dog_nougat', // same person, older full nickname
  WombatVet: 'wombatvet',
  'Fenix Down': 'fenix_down1',
  Kirios: 'kirios86',
  // Alumni: appear in historical seasons but never joined the current
  // GT-GridStats-tracked roster. No verified real PSN -- slugified
  // sheet nickname used as a historical-only identifier.
  "O'Breezy": 'o_breezy',
  BitBasher: 'bitbasher',
  Gettin_Fresh: 'gettin_fresh',
  Prototype: 'prototype',
  omgitsbees: 'omgitsbees',
  Fingat: 'fingat',
  Boco_T: 'boco_t',
  Cheeto: 'cheeto',
  NerdsMcGee: 'nerdsmcgee',
};
const ALUMNI_PSNS = new Set([
  'o_breezy',
  'bitbasher',
  'gettin_fresh',
  'prototype',
  'omgitsbees',
  'fingat',
  'boco_t',
  'cheeto',
  'nerdsmcgee',
]);

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function mdToIso(mmdd, year) {
  const [m, d] = mmdd.split('/').map((x) => parseInt(x, 10));
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseTime(s) {
  if (!s) return NaN;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isNaN(n) ? NaN : n * 1000;
}

async function main() {
  const pointsConfig = await loadPointsConfig();
  const seasons = [];
  const alumniSeen = new Map(); // psn -> earliest season id (for joinedSeason)
  const eventFiles = {}; // relPath -> data
  let eventIndex = [];
  const resultsByEvent = new Map();

  for (const [seasonId, meta] of Object.entries(SEASON_META)) {
    console.log(`Fetching ${meta.name}...`);
    const rows = await fetchSeasonRows(meta.gid);
    const season = parseSeasonTab(rows);

    const allDates = season.events.map((e) => mdToIso(e.date, meta.year));
    const startDate = allDates.reduce((a, b) => (a < b ? a : b));
    const endDate = allDates.reduce((a, b) => (a > b ? a : b));
    seasons.push({ id: seasonId, name: meta.name, startDate, endDate, current: false });

    // Group raw rows by event (circuit+date), across all sheet drivers.
    const eventsByKey = new Map();
    for (const p of season.players) {
      for (const e of p.perEvent) {
        const key = `${e.circuit}__${e.date}`;
        if (!eventsByKey.has(key)) eventsByKey.set(key, { meta: e, rows: [] });
        eventsByKey.get(key).rows.push({ driver: p.driver, time: e.time });
      }
    }

    for (const [key, { meta: em, rows }] of eventsByKey) {
      const isoDate = mdToIso(em.date, meta.year);
      const eventId = `${seasonId}-${slugify(em.circuit)}-${isoDate}`;

      const resultRows = [];
      for (const row of rows) {
        const excludeKey = `${seasonId}__${em.circuit}__${em.date}__${row.driver}`;
        if (EXCLUDED_ROWS.has(excludeKey)) continue;
        const psn = NAME_TO_PSN[row.driver];
        if (!psn) throw new Error(`Unmapped driver name: "${row.driver}" (${seasonId})`);
        if (ALUMNI_PSNS.has(psn) && !alumniSeen.has(psn)) alumniSeen.set(psn, seasonId);
        const timeMs = parseTime(row.time);
        resultRows.push({ eventId, psn, timeRaw: row.time, timeMs: Number.isNaN(timeMs) ? null : timeMs });
      }

      const scored = rankAndScoreResults(resultRows, pointsConfig).map((r) => ({
        eventId: r.eventId,
        psn: r.psn,
        timeRaw: r.timeRaw,
        timeMs: r.timeMs,
        groupRank: r.groupRank,
        points: r.points,
      }));

      // Keep the real TT window, GT7 spelling and car if a previous merge
      // filled them in; the sheet only knows the week the TT closed.
      let existing = null;
      try {
        existing = JSON.parse(readFileSync(path.join(DATA_DIR, `official-events/${eventId}.json`), 'utf-8'));
      } catch {}
      eventFiles[`official-events/${eventId}.json`] = {
        id: eventId,
        source: 'historical',
        seasonId,
        track: existing?.track ?? em.circuit,
        car: existing?.car ?? em.car ?? null,
        classCode: existing?.classCode ?? null,
        startDate: existing?.startDate ?? isoDate,
        endDate: existing?.endDate ?? isoDate,
      };
      eventIndex.push(eventId);
      resultsByEvent.set(eventId, scored);
    }
  }

  const fs = await import('node:fs');

  // Write historical event files. (Deterministic ids, so this cleanly
  // overwrites on re-run -- no separate "retag existing events" step needed
  // or wanted: that would stomp on seasonId set by the live/gap-fill
  // scraper for events this script doesn't own.)
  for (const [relPath, contents] of Object.entries(eventFiles)) {
    const full = path.join(DATA_DIR, relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(contents, null, 2) + '\n');
  }

  // Merge results: the sheet's rows replace that player's row on the same
  // event; rows for players the sheet never had (merged in from GT-GridStats
  // on 2026-09-28) stay, then every touched event is re-ranked and re-scored.
  const thisRunEventIds = new Set(eventIndex);
  const existingResults = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'results/official.json'), 'utf-8'));
  const untouched = existingResults.filter((r) => !thisRunEventIds.has(r.eventId));
  const rescored = [];
  for (const [eventId, sheetRows] of resultsByEvent) {
    const sheetPsns = new Set(sheetRows.map((r) => r.psn.toLowerCase()));
    const extra = existingResults.filter((r) => r.eventId === eventId && !sheetPsns.has(r.psn.toLowerCase()));
    rescored.push(
      ...rankAndScoreResults([...sheetRows, ...extra], pointsConfig).map((r) => ({
        eventId,
        psn: r.psn,
        timeRaw: r.timeRaw,
        timeMs: r.timeMs,
        groupRank: r.groupRank,
        points: r.points,
      }))
    );
  }
  const allResults = [...untouched, ...rescored].sort(
    (a, b) => a.eventId.localeCompare(b.eventId) || (a.groupRank ?? 999) - (b.groupRank ?? 999) || a.psn.localeCompare(b.psn)
  );
  writeFileSync(path.join(DATA_DIR, 'results/official.json'), JSON.stringify(allResults, null, 2) + '\n');

  // Update players.json: rename joinedSeason 's1' -> 'summer-2026', add alumni entries.
  const players = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'players.json'), 'utf-8'));
  for (const p of players) {
    if (p.joinedSeason === 's1') p.joinedSeason = 'summer-2026';
  }
  const existingPsns = new Set(players.map((p) => p.psn));
  for (const [psn, joinedSeason] of alumniSeen) {
    if (existingPsns.has(psn)) continue;
    const displayName = Object.entries(NAME_TO_PSN).find(([, v]) => v === psn)?.[0] ?? psn;
    players.push({
      psn,
      displayName,
      active: false,
      joinedSeason,
      note: 'Historical roster member from the imported spreadsheet archive; PSN unconfirmed, not live-tracked.',
    });
  }
  writeFileSync(path.join(DATA_DIR, 'players.json'), JSON.stringify(players, null, 2) + '\n');

  console.log(`Historical events written: ${Object.keys(eventFiles).length}`);
  console.log(`Historical result rows written: ${[...resultsByEvent.values()].flat().length}`);
  console.log(`Alumni added: ${[...alumniSeen.keys()].join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
