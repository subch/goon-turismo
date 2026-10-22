#!/usr/bin/env node
/**
 * The crew's Discord posts, sent as the Goon Turismo bot. Runs once a day at
 * noon Central, straight after that hour's GT-GridStats sync (goon-scraper's
 * crond, `sync.sh discord noon`, in subch-vps), and sends, each only once:
 *
 *   results   a Time Trial that has just closed: the crew's laps, points, and
 *             the GT7 medal each lap finished with against the final world #1
 *   new       a Time Trial that has just gone live: track, car, tyres, race
 *             settings, open/close times, the world #1 so far and the medal
 *             targets it sets
 *   world #1  a running Time Trial's world #1 time changed since yesterday,
 *             which moves every medal cut-off with it (scripts/discord/format.mjs)
 *
 * The crew's laps come from data/ as the sync left it (this never writes
 * there); everything about the Time Trials themselves from dg-edge
 * (scripts/lib/dg-edge-events.mjs). What has been sent is remembered per
 * channel in GOON_DISCORD_STATE_DIR, so a re-run sends nothing twice and a
 * new channel starts from the last few days. The rules for what is due are
 * in scripts/discord/plan.mjs.
 *
 *   npm run post:discord                          post what is due
 *   npm run post:discord -- --dry-run             print it instead; send and save nothing
 *   npm run post:discord -- --results <event id>  (re)post one Time Trial's results
 *   npm run post:discord -- --dry-run --now 2026-10-22T17:00:00Z   as if it were then
 *
 * Env (a .env in the repo root is read when there is one, for local runs):
 *   GOON_DISCORD_BOT_TOKEN   the bot's token; unset means --dry-run
 *   GOON_DISCORD_CHANNEL_ID  the channel to post in; unset means --dry-run
 *   GOON_DISCORD_STATE_DIR   where the per-channel state lives (default .discord-state/)
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fetchTimeTrials, fetchTimeTrialDetail, sameTimeTrial } from './lib/dg-edge-events.mjs';
import { dueResults, dueAnnouncements, leaderChanges, nextState, trialKey, hasClosed } from './discord/plan.mjs';
import { resultsMessage, newTrialMessage, leaderChangeMessage } from './discord/format.mjs';
import { isBotToken, isSnowflake, postMessage, statePath, loadState, saveState } from './discord/io.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const log = (msg) => console.log(msg);
const warn = (msg) => console.warn(`WARN: ${msg}`);

async function loadJson(relPath, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA, relPath), 'utf-8'));
  } catch {
    return fallback;
  }
}

async function loadEvents() {
  const dir = path.join(DATA, 'official-events');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf-8'))));
}

/** Plain-text rendering of a payload, for --dry-run and the log. */
function preview(kind, payload) {
  const out = [`--- ${kind} ---`, payload.content];
  for (const e of payload.embeds) {
    out.push(`[${e.title}](${e.url})`, e.description);
    for (const f of e.fields ?? []) out.push(`> ${f.name}`, f.value);
    if (e.image) out.push(`(image: ${e.image.url})`);
    if (e.thumbnail) out.push(`(thumbnail: ${e.thumbnail.url})`);
    if (e.footer) out.push(`(${e.footer.text})`);
  }
  return out.join('\n');
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      results: { type: 'string' },
      now: { type: 'string' },
    },
  });
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now "${args.now}" is not a date`);

  if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
  const token = process.env.GOON_DISCORD_BOT_TOKEN ?? '';
  const channelId = (process.env.GOON_DISCORD_CHANNEL_ID ?? '').trim();
  let dryRun = args['dry-run'];
  if (!dryRun && !(isBotToken(token) && isSnowflake(channelId))) {
    if (!token) warn('GOON_DISCORD_BOT_TOKEN is not set -- previewing instead of posting.');
    else if (!isBotToken(token)) warn('GOON_DISCORD_BOT_TOKEN does not look like a bot token (Bot > Reset Token in the Developer Portal) -- previewing instead.');
    if (!isSnowflake(channelId)) warn('GOON_DISCORD_CHANNEL_ID is not a channel id -- previewing instead of posting.');
    dryRun = true;
  }
  const stateDir = path.resolve(ROOT, process.env.GOON_DISCORD_STATE_DIR || '.discord-state');
  const stateFile = statePath(stateDir, isSnowflake(channelId) ? channelId : 'preview');

  const [events, results, players, seasons, syncStatus, state] = await Promise.all([
    loadEvents(),
    loadJson('results/official.json', []),
    loadJson('players.json', []),
    loadJson('seasons.json', []),
    loadJson('sync-status.json', null),
    loadState(stateFile),
  ]);
  const playerByPsn = new Map(players.map((p) => [p.psn.toLowerCase(), p]));
  const name = (psn) => playerByPsn.get(psn.toLowerCase())?.displayName ?? psn;
  const crewRows = (eventId) =>
    eventId ? results.filter((r) => r.eventId === eventId && r.timeMs != null).sort((a, b) => a.timeMs - b.timeMs) : [];
  const siteEventFor = (trial) => events.find((e) => sameTimeTrial(trial, e)) ?? null;
  log(
    `Discord poster at ${now.toISOString()}${dryRun ? ' (dry run)' : ` -> channel ${channelId}`}; ` +
      `last sync finished ${syncStatus?.finishedAt ?? 'never'}`
  );

  // A dg-edge outage must not hold back the results post, which only needs
  // data/ -- it just goes out without medals, and there are no "new" or
  // "world #1" posts today.
  let trials = null;
  try {
    trials = await fetchTimeTrials();
  } catch (err) {
    warn(`could not read dg-edge's Time Trials: ${err.message}`);
  }
  // Each trial's own page names the world #1 and has the medal shares. Read
  // for every live trial (two, usually) and for any closed one being posted.
  const detailed = new Map();
  async function detail(trial) {
    if (!detailed.has(trial.dgId)) {
      detailed.set(
        trial.dgId,
        await fetchTimeTrialDetail(trial).catch((err) => {
          warn(`could not read dg-edge's page for ${trial.track}: ${err.message}`);
          return trial;
        })
      );
    }
    return detailed.get(trial.dgId);
  }

  const messages = []; // { kind, payload, onSent(state) }

  // --- results -------------------------------------------------------------
  let closed;
  if (args.results) {
    const ev = events.find((e) => e.id === args.results);
    if (!ev) throw new Error(`no official event with id "${args.results}"`);
    closed = [ev];
  } else {
    const { due, waiting } = dueResults({ events, syncStatus, state, now });
    for (const ev of waiting) warn(`${ev.id} has closed but no sync has run since -- its results wait for the next run`);
    closed = due;
  }
  for (const ev of closed) {
    const match = trials?.find((t) => sameTimeTrial(t, ev) && hasClosed(t, now));
    if (trials && !match) warn(`${ev.id} is not among dg-edge's closed Time Trials -- posting it without medals`);
    messages.push({
      kind: `results ${ev.id}`,
      payload: resultsMessage({
        event: ev,
        rows: crewRows(ev.id),
        name,
        seasonName: seasons.find((s) => s.id === ev.seasonId)?.name,
        final: match ? await detail(match) : null,
      }),
      onSent: (s) => {
        if (!s.resultsPosted.includes(ev.id)) s.resultsPosted.push(ev.id);
      },
    });
  }

  // --- new Time Trials, then world #1 changes --------------------------------
  // --results is a one-off: it sends that post and leaves the daily ones (and
  // their state) alone.
  const changedKeys = new Set();
  let live = [];
  if (trials && !args.results) {
    live = await Promise.all(trials.filter((t) => t.status === 'live' && !hasClosed(t, now)).map(detail));
    for (const t of live) log(`live: ${t.track} (${t.startsAt} - ${t.endsAt}) world #1 ${t.leadMs ?? 'none'} ${t.leader?.name ?? ''}`);

    const announced = new Set();
    for (const trial of dueAnnouncements({ trials: live, state, now })) {
      const eventId = siteEventFor(trial)?.id ?? null;
      announced.add(trialKey(trial));
      messages.push({
        kind: `new ${trial.track} (${trialKey(trial)})`,
        payload: newTrialMessage({ trial, eventId, crew: crewRows(eventId), name }),
        onSent: (s) => s.announced.push(trialKey(trial)),
      });
    }

    const changes = leaderChanges({ trials: live, state, now, skipKeys: announced }).map(({ trial, previous }) => {
      const eventId = siteEventFor(trial)?.id ?? null;
      return { trial, previous, eventId, crew: crewRows(eventId) };
    });
    if (changes.length) {
      for (const c of changes) changedKeys.add(trialKey(c.trial));
      messages.push({
        kind: `world #1 (${changes.length})`,
        payload: leaderChangeMessage({ changes, name }),
        onSent: () => changedKeys.clear(),
      });
    }
  }

  // --- send ------------------------------------------------------------------
  // State is saved after every message, so a failure part-way through never
  // re-sends what already went out.
  let failed = 0;
  for (const msg of messages) {
    log(preview(msg.kind, msg.payload));
    if (dryRun) continue;
    try {
      await postMessage(token, channelId, msg.payload);
      msg.onSent(state);
      await saveState(stateFile, state);
      log(`sent: ${msg.kind}`);
    } catch (err) {
      failed++;
      console.error(`FAILED to send ${msg.kind}: ${err.message}`);
    }
  }
  if (!messages.length) log('nothing due today');

  // Today's world #1 readings are what tomorrow compares against. If the
  // world #1 message failed to send, changedKeys still holds its trials and
  // their last announced reading is kept, so tomorrow reports the whole move.
  if (!dryRun && !args.results) await saveState(stateFile, nextState({ state, trials: live, now, hold: changedKeys }));
  log(
    dryRun
      ? `done: ${messages.length} previewed (dry run: nothing sent or saved)`
      : `done: ${messages.length - failed} sent, ${failed} failed`
  );
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
