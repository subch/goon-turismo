// npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatMs, formatDelta, cutoffMs, tierFor, TIERS, md, resultsMessage, leaderChangeMessage, newTrialMessage } from './format.mjs';
import { dueResults, dueAnnouncements, leaderChanges, nextState, emptyState, trialKey } from './plan.mjs';
import { isBotToken, isSnowflake, postMessage, statePath, loadState, saveState } from './io.mjs';

const at = (iso) => new Date(iso);
const name = (psn) => psn;

test('formatMs renders lap times the way GT7 does', () => {
  assert.equal(formatMs(76835), '1:16.835');
  assert.equal(formatMs(65004), '1:05.004');
  assert.equal(formatMs(59123), '59.123');
  assert.equal(formatDelta(1290), '+1.290');
  assert.equal(formatDelta(-65), '−0.065');
});

test('GT7 medal cut-offs are 3/5/10% off the world #1, rounded up as dg-edge shows them', () => {
  // Brands Hatch, final: dg-edge listed gold 1:42.110, silver 1:44.092, bronze 1:49.049.
  assert.deepEqual(TIERS.map((t) => formatMs(cutoffMs(99135, t))), ['1:42.110', '1:44.092', '1:49.049']);
  // SUGO: 1:19.141, not the 1:19.140 that rounding down gives.
  assert.equal(cutoffMs(76835, TIERS[0]), 79141);
  // A whole multiple stays exact (100000 * 1.03 in floating point is 103000.00000000001).
  assert.equal(cutoffMs(100000, TIERS[0]), 103000);
  assert.equal(tierFor(79141, 76835).key, 'gold');
  assert.equal(tierFor(79142, 76835).key, 'silver');
  assert.equal(tierFor(cutoffMs(76835, TIERS[2]) + 1, 76835), null);
  assert.equal(tierFor(80000, null), null);
});

test('md escapes the underscores PSN ids are full of', () => {
  assert.equal(md('empire_of_ravens'), 'empire\\_of\\_ravens');
  assert.equal(md('AT__1826'), 'AT\\_\\_1826');
});

const dragon = {
  id: 'tt-2026-10-08-dragon-trail-gardens',
  source: 'gridstats',
  seasonId: 'autumn-2026',
  track: 'Dragon Trail - Gardens',
  car: 'GReddy Fugu Z',
  startDate: '2026-10-08',
  endDate: '2026-10-22',
};
const syncedAt = (iso) => ({ finishedAt: iso });

test('results wait for the close and for a sync after it', () => {
  const state = emptyState();
  // Close day, before GT7 has certainly rotated: not due, not waiting.
  let r = dueResults({ events: [dragon], syncStatus: syncedAt('2026-10-22T06:49:00Z'), state, now: at('2026-10-22T08:00:00Z') });
  assert.deepEqual([r.due, r.waiting], [[], []]);
  // Noon Central, but the last sync ran before the close: wait.
  r = dueResults({ events: [dragon], syncStatus: syncedAt('2026-10-22T06:49:00Z'), state, now: at('2026-10-22T17:00:00Z') });
  assert.deepEqual([r.due, r.waiting.map((e) => e.id)], [[], [dragon.id]]);
  // The noon sync has run: due.
  r = dueResults({ events: [dragon], syncStatus: syncedAt('2026-10-22T17:02:00Z'), state, now: at('2026-10-22T17:03:00Z') });
  assert.deepEqual(r.due.map((e) => e.id), [dragon.id]);
});

test('results are posted once, recently closed only, never spreadsheet history', () => {
  const syncStatus = syncedAt('2026-10-25T12:49:00Z');
  const posted = { ...emptyState(), resultsPosted: [dragon.id] };
  assert.deepEqual(dueResults({ events: [dragon], syncStatus, state: posted, now: at('2026-10-23T17:00:00Z') }).due, []);
  // A missed day catches up; a week later is too old.
  assert.equal(dueResults({ events: [dragon], syncStatus, state: emptyState(), now: at('2026-10-25T17:00:00Z') }).due.length, 1);
  assert.equal(dueResults({ events: [dragon], syncStatus, state: emptyState(), now: at('2026-10-29T17:00:00Z') }).due.length, 0);
  const historical = { ...dragon, id: 'autumn-2025-x', source: 'historical' };
  assert.deepEqual(dueResults({ events: [historical], syncStatus, state: emptyState(), now: at('2026-10-23T17:00:00Z') }).due, []);
});

// A dg-edge trial, as lib/dg-edge-events.mjs gives it (after its detail page).
const sugo = (leadMs, leaderName = 'AT__1826') => ({
  dgId: '676',
  url: 'https://www.dg-edge.com/events/time-trials/vision-gran-turismo-sugo-international-racing-course/676',
  track: 'SUGO International Racing Course',
  car: 'Xiaomi Vision Gran Turismo',
  tyres: 'SS',
  settings: ['15:00', 'BoP', 'Start attack', 'No tuning'],
  startsAt: '2026-10-15T07:00:00.000Z',
  endsAt: '2026-10-29T06:59:59.000Z',
  startDate: '2026-10-15',
  endDate: '2026-10-29',
  status: 'live',
  leadMs,
  drivers: 93635,
  leader: leadMs ? { name: leaderName, timeMs: leadMs } : null,
  medalShare: { gold: 4.13, silver: 12.97, bronze: 67.32 },
  trackImage: 'https://data.dg-edge.com/images/tracks/392/back1340-new.webp',
});

test('a new Time Trial is announced once, only once it has opened, and only while it is new', () => {
  const now = at('2026-10-15T17:00:00Z');
  assert.equal(dueAnnouncements({ trials: [sugo(76835)], state: emptyState(), now }).length, 1);
  assert.equal(dueAnnouncements({ trials: [sugo(76835)], state: emptyState(), now: at('2026-10-15T06:00:00Z') }).length, 0);
  const announced = { ...emptyState(), announced: [trialKey(sugo())] };
  assert.equal(dueAnnouncements({ trials: [sugo(76835)], state: announced, now }).length, 0);
  // A first run part-way through a Time Trial (a new channel, say) does not announce it.
  assert.equal(dueAnnouncements({ trials: [sugo(76835)], state: emptyState(), now: at('2026-10-22T17:00:00Z') }).length, 0);
});

test('a world #1 change needs a previous reading and a different time, on a live trial', () => {
  const now = at('2026-10-20T17:00:00Z');
  const seen = (timeMs, leaderName = 'someone') => ({
    ...emptyState(),
    leaders: { [trialKey(sugo())]: { track: 'SUGO', startDate: '2026-10-15', name: leaderName, timeMs, seenAt: '2026-10-19T17:00:00Z' } },
  });
  assert.equal(leaderChanges({ trials: [sugo(76835)], state: emptyState(), now }).length, 0);
  assert.equal(leaderChanges({ trials: [sugo(76835)], state: seen(76835, 'tied_driver'), now }).length, 0);
  assert.equal(leaderChanges({ trials: [sugo(76835)], state: seen(76900), now }).length, 1);
  assert.equal(leaderChanges({ trials: [sugo(76835)], state: seen(76900), now, skipKeys: new Set([trialKey(sugo())]) }).length, 0);
  // Past its close it is the results post's business.
  assert.equal(leaderChanges({ trials: [sugo(76835)], state: seen(76900), now: at('2026-10-29T07:00:00Z') }).length, 0);
});

test('nextState records today, keeps what it could not read, and can hold a reading', () => {
  const now = at('2026-10-20T17:00:00Z');
  const old = { track: 'Old', startDate: '2026-09-01', name: 'x', timeMs: 1, seenAt: '2026-09-10T17:00:00Z' };
  const yesterday = { track: 'SUGO', startDate: '2026-10-15', name: 'was_here', timeMs: 76900, seenAt: '2026-10-19T17:00:00Z' };
  const state = { ...emptyState(), leaders: { 'dg-edge:600': old, [trialKey(sugo())]: yesterday } };
  assert.deepEqual(Object.keys(nextState({ state, trials: [], now }).leaders), [trialKey(sugo())]);
  const today = nextState({ state, trials: [sugo(76835)], now }).leaders[trialKey(sugo())];
  assert.deepEqual([today.timeMs, today.name], [76835, 'AT__1826']);
  const held = nextState({ state, trials: [sugo(76835)], now, hold: new Set([trialKey(sugo())]) });
  assert.equal(held.leaders[trialKey(sugo())].timeMs, 76900);
  // The detail page could not be read: same time keeps the known name.
  const unnamed = { ...sugo(76900), leader: null };
  assert.equal(nextState({ state, trials: [unnamed], now }).leaders[trialKey(sugo())].name, 'was_here');
});

test('the results post ranks the crew and counts GT7 medals against the final world #1', () => {
  const rows = [
    { psn: 'devmotron', timeMs: 102845, points: 77 },
    { psn: 'bravemen84', timeMs: 100491, points: 100 },
    { psn: 'empire_of_ravens', timeMs: 101390, points: 91 },
    { psn: 'superpharts', timeMs: 101736, points: 88 },
    { psn: 'no_time', timeMs: null, points: 0 },
  ];
  const event = { ...dragon, id: 'tt-x', track: 'Brands Hatch Grand Prix Circuit' };
  const final = { leadMs: 99135, leader: { name: 'D. Chafe' }, url: 'https://www.dg-edge.com/events/time-trials/x/671', trackImage: 'https://img/x.webp' };
  const msg = resultsMessage({ event, rows, name, seasonName: 'Autumn 2026', final });
  const [embed] = msg.embeds;
  assert.match(embed.description, /^🥇 \*\*bravemen84\*\* 1:40\.491 · 100 pts 🟡$/m);
  assert.match(embed.description, /^🥈 \*\*empire\\_of\\_ravens\*\* 1:41\.390 · 91 pts 🟡$/m);
  assert.match(embed.description, /^4\\\. \*\*devmotron\*\* 1:42\.845 · 77 pts ⚪$/m);
  assert.doesNotMatch(embed.description, /no\\_time/);
  assert.equal(embed.fields[0].name, 'GT7 medals: 🟡×3 ⚪×1');
  assert.match(embed.fields[0].value, /Final world #1 \*\*1:39\.135\*\* by D\. Chafe/);
  // The photo goes underneath; a thumbnail would narrow every driver line.
  assert.equal(embed.image.url, final.trackImage);
  assert.equal(embed.thumbnail, undefined);
  assert.deepEqual(msg.allowed_mentions, { parse: [] });

  const noBoard = resultsMessage({ event, rows, name, final: null });
  assert.deepEqual(noBoard.embeds[0].fields, []);
  assert.doesNotMatch(noBoard.embeds[0].description, /🟡/);
});

test('the new Time Trial post carries the settings, local-time close and medal targets', () => {
  const [embed] = newTrialMessage({ trial: sugo(76835), eventId: null, crew: [], name }).embeds;
  assert.equal(embed.url, sugo().url); // no site page yet: dg-edge's
  assert.match(embed.description, /Sports Soft \(SS\) · 15:00 · BoP · Start attack · No tuning/);
  assert.match(embed.description, /^Closes <t:1793257199:f> \(<t:1793257199:R>\)$/m);
  assert.equal(embed.fields.find((f) => f.name === 'GT7 medal targets').value.split('\n')[0], '🟡 Gold ≤ 1:19.141');
  assert.equal(embed.fields.find((f) => f.name === 'Drivers').value, '93,635\n4.13% in gold');
  assert.equal(embed.image.url, sugo().trackImage);
  assert.equal(embed.thumbnail, undefined);
});

test('the world #1 post shows who the moving cut-off pushed down a tier', () => {
  const msg = leaderChangeMessage({
    name,
    changes: [
      {
        trial: { ...sugo(105285, '拙者RBで候'), track: 'Dragon Trail - Gardens', endsAt: '2026-10-22T06:59:59.000Z' },
        previous: { name: 'AMS__Andrew', timeMs: 105611 },
        eventId: dragon.id,
        crew: [
          { psn: 'bravemen84', timeMs: 106818 },
          { psn: 'rickiep00h', timeMs: 110574 },
        ],
      },
    ],
  });
  const [embed] = msg.embeds;
  assert.equal(embed.url, 'https://goon-turismo.com/events/tt-2026-10-08-dragon-trail-gardens/');
  assert.match(embed.description, /World #1 \*\*1:45\.285\*\* by 拙者RBで候\nwas 1:45\.611 by AMS\\_\\_Andrew \(−0\.326\)/);
  assert.match(embed.description, /Gold is now ≤ \*\*1:48\.444\*\* \(was 1:48\.780\)/);
  assert.equal(embed.fields[0].name, 'Crew right now · (gap to gold) · ↓ dropped a tier');
  const crew = embed.fields[0].value.split('\n');
  assert.equal(crew[0], '🟡 **bravemen84** 1:46.818');
  assert.equal(crew[1], '🟤 **rickiep00h** 1:50.574 (+2.130) ↓');
});

// What a phone shows of a line: Markdown marks and escapes take no room, an
// emoji takes about two letters.
function shownWidth(line) {
  const text = line.replace(/\*\*/g, '').replace(/\\(.)/g, '$1');
  return [...text].reduce((w, ch) => w + (/\p{Extended_Pictographic}/u.test(ch) ? 2 : /️/.test(ch) ? 0 : 1), 0);
}

test('every driver line fits one line on a phone, even for the longest name on the roster', () => {
  const longest = 'empire_of_ravens'; // 16, the longest PSN in data/players.json
  const rows = [
    { psn: 'bravemen84', timeMs: 100491, points: 100 },
    { psn: longest, timeMs: 109999, points: -88 },
    { psn: 'x', timeMs: 120000, points: -194 },
  ];
  const results = resultsMessage({ event: { ...dragon, id: 'tt-x' }, rows, name, final: { leadMs: 99135 } }).embeds[0];
  const resultLines = results.description.split('\n').filter((l) => l.includes(md(longest)));
  const crew = leaderChangeMessage({
    name,
    changes: [{ trial: sugo(105285), previous: { timeMs: 104000 }, eventId: null, crew: [{ psn: longest, timeMs: 116999 }] }],
  }).embeds[0].fields[0].value.split('\n');
  for (const line of [...resultLines, ...crew]) assert.ok(shownWidth(line) <= 40, `${shownWidth(line)} wide: ${line}`);
});

// Fake tokens are deliberately not Discord-shaped (a real one starts with
// M/N/O): GitHub push protection blocks anything that looks like one.
const FAKE_TOKEN = 'test-not-a-real-token-xxxx.fake.test-not-a-real-token-yyyy';

test('only a bot token and a channel id are used as such', () => {
  assert.ok(isBotToken(FAKE_TOKEN));
  assert.ok(!isBotToken('50bfa0d6cc3ce31711a5ee660e7d6cf16629fdc57357666314b6a3742e7ed5cb')); // the public key
  assert.ok(!isBotToken('1562652320683266178')); // the application id
  assert.ok(!isBotToken(''));
  assert.ok(isSnowflake('1562652320683266178'));
  assert.ok(!isSnowflake('#general'));
});

test('postMessage waits out a rate limit, explains a refusal, and never leaks the token', async () => {
  const token = FAKE_TOKEN;
  const calls = [];
  const replies = [
    new Response(JSON.stringify({ retry_after: 0.01, message: 'You are being rate limited.' }), { status: 429 }),
    new Response('{"id":"1"}', { status: 200 }),
    new Response('{"message":"Missing Access","code":50001}', { status: 403 }),
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, ua: init.headers['User-Agent'] });
    return replies.shift();
  };
  try {
    assert.deepEqual(await postMessage(token, '1234567890123456789', { content: 'hi' }), { id: '1' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/1234567890123456789/messages');
    assert.equal(calls[0].auth, `Bot ${token}`);
    assert.match(calls[0].ua, /^DiscordBot \(/);
    await assert.rejects(postMessage(token, '1234567890123456789', { content: 'hi' }), (err) => {
      assert.match(err.message, /403.*Missing Access.*cannot see that channel/);
      assert.ok(!err.message.includes(token));
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('state is per channel: a missing file is a first run, a corrupt one is an error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'goon-discord-'));
  try {
    const file = statePath(path.join(dir, 'nested'), '1234567890123456789');
    assert.equal(path.basename(file), '1234567890123456789.json');
    assert.deepEqual(await loadState(file), emptyState());
    await saveState(file, { ...emptyState(), resultsPosted: ['tt-x'] });
    assert.deepEqual((await loadState(file)).resultsPosted, ['tt-x']);
    await writeFile(file, '{ not json');
    await assert.rejects(loadState(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
