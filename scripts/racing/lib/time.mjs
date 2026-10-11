// Wall-clock time in a named zone -> UTC ISO, DST-aware. For sources that
// publish a session's local start time without a usable offset.
//
//   wallTimeToUtc('2026-10-11T15:00:00', 'Asia/Makassar') -> '2026-10-11T07:00:00.000Z'
//
// Zone names are IANA ids in any case (MotoGP sends 'ASIA/MAKASSAR'). Returns
// null for a missing/unparseable time or an unknown zone, never a guess.

function offsetAt(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  // What the zone shows at that instant, read as if it were UTC, minus the instant.
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - ms;
}

export function wallTimeToUtc(local, timeZone) {
  if (!local || !timeZone) return null;
  const naive = Date.parse(`${String(local).slice(0, 19)}Z`);
  if (Number.isNaN(naive)) return null;
  try {
    // The offset is looked up at the naive instant first, then again at the
    // corrected one, so a time within a few hours of a DST switch still lands
    // on the right side of it.
    const guess = naive - offsetAt(naive, timeZone);
    return new Date(naive - offsetAt(guess, timeZone)).toISOString();
  } catch {
    return null; // Intl throws RangeError on a zone it doesn't know
  }
}
