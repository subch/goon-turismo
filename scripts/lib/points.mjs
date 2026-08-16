import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../data/points-config.json');

let cachedConfig = null;

/**
 * Load points-config.json (cached after first read).
 */
export async function loadPointsConfig() {
  if (!cachedConfig) {
    cachedConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  }
  return cachedConfig;
}

/**
 * Given a 1-indexed rank *within the group* (not dg-edge's global rank),
 * return the points awarded per data/points-config.json.
 */
export function pointsForRank(rank, config) {
  if (!rank || rank < 1) return 0;
  const idx = rank - 1;
  if (idx < config.pointsByRank.length) {
    return config.pointsByRank[idx];
  }
  return config.pointsBeyond ?? 0;
}

/**
 * Rank a list of results (already filtered to a single event) by time ascending
 * (lower/faster time = better rank), assigning group points.
 * `results` items need a `timeMs` field (parsed lap/total time in milliseconds).
 */
export function rankAndScoreResults(results, config) {
  const timed = results.filter((r) => typeof r.timeMs === 'number' && !Number.isNaN(r.timeMs));
  const untimed = results.filter((r) => !timed.includes(r));
  timed.sort((a, b) => a.timeMs - b.timeMs);
  return [
    ...timed.map((r, i) => ({
      ...r,
      groupRank: i + 1,
      points: pointsForRank(i + 1, config) + (config.participationBonus ?? 0),
    })),
    ...untimed.map((r) => ({ ...r, groupRank: null, points: config.participationBonus ?? 0 })),
  ];
}

/**
 * Parse a GT7-style lap/time string like "1:23.456" or "23.456" into milliseconds.
 * Returns NaN if it can't be parsed.
 */
export function parseTimeToMs(timeStr) {
  if (!timeStr) return NaN;
  const s = String(timeStr).trim();
  const m = s.match(/^(?:(\d+):)?(\d+)(?:\.(\d+))?$/);
  if (!m) return NaN;
  const minutes = m[1] ? parseInt(m[1], 10) : 0;
  const seconds = parseInt(m[2], 10);
  const fraction = m[3] ? parseFloat(`0.${m[3]}`) : 0;
  return (minutes * 60 + seconds + fraction) * 1000;
}
