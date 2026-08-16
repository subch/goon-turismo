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
 * Score a single time against the fastest time set *within the group* for
 * that event (not dg-edge/GT-GridStats global rank). Matches the formula
 * confirmed against the crew's historical scoring spreadsheet: the fastest
 * group time always scores exactly 100, and every 1% off that pace costs
 * 10 points. There's no floor -- a bad enough run can and does go negative
 * (confirmed against real historical data, e.g. -88 for a run ~18.8% off
 * pace), so don't clamp to 0 here.
 */
export function scoreFromTime(timeMs, bestMs, config) {
  const pctOff = ((timeMs - bestMs) / bestMs) * 100;
  return Math.round((config.basePoints ?? 100) - (config.pointsLostPerPercentOff ?? 10) * pctOff);
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
  const bestMs = timed.length ? timed[0].timeMs : null;
  return [
    ...timed.map((r, i) => ({
      ...r,
      groupRank: i + 1,
      points: scoreFromTime(r.timeMs, bestMs, config),
    })),
    ...untimed.map((r) => ({ ...r, groupRank: null, points: 0 })),
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
