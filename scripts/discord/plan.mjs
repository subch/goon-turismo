// What is due on a given run. Pure: the site's data, dg-edge's Time Trials and
// the state file go in, decisions come out. scripts/post-discord.mjs does the I/O.
//
// Two kinds of record meet here:
//   site events   data/official-events, GT-GridStats naming, dates only; the
//                 crew's laps hang off these (results posts)
//   dg-edge trials  lib/dg-edge-events.mjs, exact UTC start/end and the live
//                 world #1 (new Time Trial and world #1 posts)
//
// State file shape (one per channel, written by post-discord.mjs):
//   resultsPosted  site event ids whose results have been posted
//   announced      trialKey()s of dg-edge Time Trials that have been announced
//   leaders        trialKey() -> { track, startDate, endDate, name, timeMs, seenAt },
//                  the world #1 at the last run, which the next run compares to

/**
 * How far back a run looks. A run that was missed (box down, sync failing)
 * catches up the next day; a first run on a fresh state file -- a new
 * channel, say -- posts nothing older than this rather than every Time Trial
 * on file.
 */
export const RECENT_DAYS = 3;

/**
 * GT7 closes a Time Trial at 06:59:59 UTC on its end date (dg-edge's exact
 * windows, 2026). Site events only carry the date, so for them a Time Trial
 * has certainly closed by this time on it; their last laps reach data/ only
 * with a sync finished after it. The noon post's own sync always is.
 */
export const CLOSED_BY_UTC = 'T09:00:00Z';

const KEEP_POSTED = 100; // ids remembered per list; far more than RECENT_DAYS needs
const KEEP_LEADER_DAYS = 21;

export function emptyState() {
  return { resultsPosted: [], announced: [], leaders: {} };
}

export function trialKey(trial) {
  return `dg-edge:${trial.dgId}`;
}

/** Whether a dg-edge trial (exact end) or a site event (end date) has closed by `now`. */
export function hasClosed(record, now) {
  if (record.endsAt) return now.getTime() > Date.parse(record.endsAt);
  return Boolean(record.endDate) && now.getTime() >= Date.parse(record.endDate + CLOSED_BY_UTC);
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/** Whole days from `iso` to the UTC date of `now` (negative = in the future). */
function daysSince(iso, now) {
  return Math.round((Date.parse(isoDay(now)) - Date.parse(iso)) / 86_400_000);
}

/**
 * Site events whose results are due: closed within RECENT_DAYS and not yet
 * posted. `waiting` have closed but their final laps are not in data/ yet (no
 * sync since the close); they are retried next run.
 */
export function dueResults({ events, syncStatus, state, now }) {
  const syncedAt = Date.parse(syncStatus?.finishedAt ?? '') || 0;
  const due = [];
  const waiting = [];
  for (const ev of events) {
    // Spreadsheet history is never "just closed"; it predates this poster.
    if (ev.source === 'historical' || !ev.endDate || state.resultsPosted.includes(ev.id)) continue;
    if (!hasClosed(ev, now) || daysSince(ev.endDate, now) > RECENT_DAYS) continue;
    (syncedAt >= Date.parse(ev.endDate + CLOSED_BY_UTC) ? due : waiting).push(ev);
  }
  const byEnd = (a, b) => a.endDate.localeCompare(b.endDate) || a.id.localeCompare(b.id);
  return { due: due.sort(byEnd), waiting: waiting.sort(byEnd) };
}

function isLive(trial, now) {
  return Boolean(trial.startsAt) && now.getTime() >= Date.parse(trial.startsAt) && !hasClosed(trial, now);
}

/** Live Time Trials that started within RECENT_DAYS and have not been announced. */
export function dueAnnouncements({ trials, state, now }) {
  return trials.filter((t) => {
    if (!isLive(t, now) || state.announced.includes(trialKey(t))) return false;
    return daysSince(t.startDate, now) <= RECENT_DAYS;
  });
}

/**
 * Live Time Trials whose world #1 time differs from the last run's -- and
 * with it every medal cut-off. A trial seen for the first time has nothing to
 * compare to, and one announced in this same run already shows its world #1,
 * so neither is a change.
 */
export function leaderChanges({ trials, state, now, skipKeys = new Set() }) {
  const changes = [];
  for (const trial of trials) {
    const key = trialKey(trial);
    const previous = state.leaders[key];
    if (!isLive(trial, now) || trial.leadMs == null || !previous || skipKeys.has(key)) continue;
    if (trial.leadMs !== previous.timeMs) changes.push({ trial, previous });
  }
  return changes;
}

/**
 * The state to save: today's world #1 for every live trial, the last reading
 * kept for the rest (a failed read is not a reason to forget), and readings
 * older than KEEP_LEADER_DAYS dropped. Trials in `hold` keep their previous
 * reading too -- a change that could not be sent is then reported, in full,
 * by the next run.
 */
export function nextState({ state, trials, now, hold = new Set() }) {
  const leaders = {};
  const cutoff = now.getTime() - KEEP_LEADER_DAYS * 86_400_000;
  for (const [key, entry] of Object.entries(state.leaders)) {
    if (Date.parse(entry.seenAt) >= cutoff) leaders[key] = entry;
  }
  for (const trial of trials ?? []) {
    const key = trialKey(trial);
    if (!isLive(trial, now) || trial.leadMs == null || (hold.has(key) && leaders[key])) continue;
    const sameTime = leaders[key]?.timeMs === trial.leadMs;
    leaders[key] = {
      track: trial.track,
      startDate: trial.startDate,
      endDate: trial.endDate,
      // Only the trial's own page names the world #1 (trial.leader); if that
      // read failed, keep the last name while the time is unchanged.
      name: trial.leader?.name ?? (sameTime ? leaders[key].name : null),
      timeMs: trial.leadMs,
      seenAt: now.toISOString(),
    };
  }
  return {
    resultsPosted: state.resultsPosted.slice(-KEEP_POSTED),
    announced: state.announced.slice(-KEEP_POSTED),
    leaders,
  };
}
