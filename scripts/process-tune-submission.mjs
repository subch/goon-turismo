#!/usr/bin/env node
/**
 * Parses a "Submit a tune" GitHub Issue Form submission and writes it to
 * data/tunes/. Expects ISSUE_NUMBER and ISSUE_BODY env vars.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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

function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function parseLines(block) {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(':');
      if (idx === -1) return [line.trim(), ''];
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    });
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
  const issueNumber = process.env.ISSUE_NUMBER;
  const body = process.env.ISSUE_BODY || '';

  const car = extractField(body, 'Car');
  const owner = extractField(body, 'Your PSN');
  const carClass = extractField(body, 'Class / PP \\(optional\\)') || extractField(body, 'Class / PP');
  const drivetrain = extractField(body, 'Drivetrain \\(optional\\)') || extractField(body, 'Drivetrain');
  const description = extractField(body, 'Description');
  const partsBlock = extractField(body, 'Parts \\(that deviate from stock\\)') || extractField(body, 'Parts');
  const settingsBlock = extractField(body, 'Settings \\(optional\\)') || extractField(body, 'Settings');
  const notes = extractField(body, 'Notes \\(optional\\)') || extractField(body, 'Notes');

  if (!car || !owner || !partsBlock) {
    console.error('Missing required fields (car, PSN, and/or parts) -- aborting.');
    console.error({ car, owner, partsBlockPresent: !!partsBlock });
    process.exit(1);
  }

  const index = await loadJson('tunes/index.json', []);
  const baseId = slugify(`${car}-${owner}`);
  let id = baseId;
  let n = 1;
  while (index.includes(id)) {
    n += 1;
    id = `${baseId}-${n}`;
  }

  const parts = parseLines(partsBlock).map(([category, name]) => ({ category, name }));
  const settings = Object.fromEntries(parseLines(settingsBlock));

  const tune = {
    id,
    car,
    owner,
    class: carClass || null,
    drivetrain: drivetrain || null,
    description: description || '',
    parts,
    settings,
    notes: notes || '',
    createdFromIssue: issueNumber ? Number(issueNumber) : null,
  };

  await saveJson(`tunes/${id}.json`, tune);
  index.push(id);
  await saveJson('tunes/index.json', index);

  console.log(`Recorded tune "${car}" by ${owner} (${id}) with ${parts.length} part(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
