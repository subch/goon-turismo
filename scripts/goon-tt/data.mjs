/**
 * Reading and writing data/goon-tt/ for the bot's scripts (submit.mjs,
 * board.mjs). `root` is the repo; tests point it at a scratch copy.
 */
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
};

/** Every Goon TT, newest first. */
export async function loadGoonTts(root = REPO) {
  const dir = path.join(root, 'data', 'goon-tt');
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
  const tts = await Promise.all(files.map((f) => readJson(path.join(dir, f))));
  return tts.sort((a, b) => b.startDate.localeCompare(a.startDate));
}

/** Written to a temp file and renamed over, so a crash never leaves half a file. */
export async function saveGoonTt(tt, root = REPO) {
  const file = path.join(root, 'data', 'goon-tt', `${tt.id}.json`);
  await writeFile(`${file}.tmp`, JSON.stringify(tt, null, 2) + '\n');
  await rename(`${file}.tmp`, file);
}

/** The roster's PSNs, and a name for each (its display name). */
export async function loadRoster(root = REPO) {
  const players = await readJson(path.join(root, 'data', 'players.json'), []);
  const names = new Map(players.map((p) => [p.psn, p.displayName || p.psn]));
  return { psns: new Set(names.keys()), name: (psn) => names.get(psn) ?? psn };
}

export async function loadPoints(root = REPO) {
  return readJson(path.join(root, 'data', 'points-config.json'), {});
}
