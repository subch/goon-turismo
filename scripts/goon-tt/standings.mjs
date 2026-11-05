/**
 * A Goon TT's board and state, shared by the site (src/lib/data.ts) and the
 * bot's /goontt reply so the two can never disagree. Pure: no files, no OCR,
 * nothing Node-only, so the site can import it.
 */

/** "1:27.864" -> 87864. Laps under a minute read "58.123". */
export function lapToMs(text) {
  const m = String(text ?? '').match(/(?:(\d{1,2}):)?(\d{2})\.(\d{3})/);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000 + Number(m[3]);
}

export function msToLap(ms) {
  const min = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0');
  return min ? `${min}:${sec}` : sec;
}

/** "+1.101"; the leader's gap is empty. */
export function gapText(ms) {
  return ms ? `+${(ms / 1000).toFixed(3)}` : '';
}

/**
 * Each driver's best lap, fastest first, with the gap to the leader and
 * points on the crew's usual scale: the fastest lap scores 100 and every 1%
 * off it costs 10, rounded, no floor -- scoreFromTime in scripts/lib/points.mjs,
 * fed the same data/points-config.json.
 */
export function board(tt, { basePoints = 100, pointsLostPerPercentOff = 10 } = {}) {
  const best = new Map();
  const attempts = new Map();
  for (const lap of tt.laps ?? []) {
    attempts.set(lap.psn, (attempts.get(lap.psn) ?? 0) + 1);
    const held = best.get(lap.psn);
    if (!held || lap.timeMs < held.timeMs) best.set(lap.psn, lap);
  }
  const laps = [...best.values()].sort((a, b) => a.timeMs - b.timeMs || String(a.submittedAt).localeCompare(String(b.submittedAt)));
  const leader = laps[0]?.timeMs;
  return laps.map((lap, i) => ({
    place: i + 1,
    psn: lap.psn,
    timeMs: lap.timeMs,
    time: msToLap(lap.timeMs),
    gapMs: lap.timeMs - leader,
    points: Math.round(basePoints - pointsLostPerPercentOff * ((lap.timeMs - leader) / leader) * 100),
    laps: attempts.get(lap.psn),
    lap,
  }));
}

/** 'upcoming', 'running' or 'closed' at `now`. */
export function status(tt, now = new Date()) {
  if (now >= new Date(tt.closesAt)) return 'closed';
  if (now < new Date(tt.opensAt)) return 'upcoming';
  return 'running';
}

/** The Goon TT running at `now`, else null. */
export function runningTt(tts, now = new Date()) {
  return tts.find((tt) => status(tt, now) === 'running') ?? null;
}

/** Tyre codes as GT7 names them. */
export const TYRE_NAMES = {
  CH: 'Comfort Hard',
  CM: 'Comfort Medium',
  CS: 'Comfort Soft',
  SH: 'Sports Hard',
  SM: 'Sports Medium',
  SS: 'Sports Soft',
  RH: 'Racing Hard',
  RM: 'Racing Medium',
  RS: 'Racing Soft',
  IM: 'Intermediate',
  W: 'Heavy Wet',
};
