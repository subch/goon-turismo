// npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeNuxtData, normalizeEvent, sameTimeTrial } from './dg-edge-events.mjs';

// A trimmed /events/time-trials payload in Nuxt's real wire format (devalue):
// one flat array of index references, ShallowReactive/Reactive wrappers, -1
// for undefined, a Set, and one object (the track) referenced twice.
const FLAT = [
  ['ShallowReactive', 1],
  { data: 2, state: 3 },
  ['ShallowReactive', 4],
  ['Reactive', 5],
  { 'events/RBNvo1WzZ4oRRq0W9': 6 },
  { seen: 7 },
  { success: 8, payload: 9 },
  ['Set', 10],
  true,
  { list: 11, pagination: -1 },
  'x',
  [12, 25],
  {
    id: 13, eventType: 14, from: 15, to: 16, tyres: 17, leadTime: 18, playersCount: 19,
    isActive: 8, isEnded: 20, isFuture: 20, track: 21, car: -1, carType: 22, slug: 23, settingsChips: 24, ogImage: -1,
  },
  672,
  'TT',
  '2026-10-08 09:00:00',
  '2026-10-22 08:59:59',
  'SH',
  105285,
  93397,
  false,
  { fullName: 26, name: 26 },
  'GR.1',
  '/events/time-trials/gr-1-dragon-trail-gardens/672',
  [27],
  { id: 28, eventType: 14, from: 29, to: 30, track: 21, isEnded: 8, slug: 23 },
  'Dragon Trail - Gardens',
  { key: 31, label: 32 },
  671,
  '2026-10-29 07:59:59',
  '2026-11-05 07:59:59',
  'time',
  '17:00',
];
const html = `<html><body><script type="application/json" id="__NUXT_DATA__" data-ssr="true">${JSON.stringify(FLAT)}</script></body></html>`;

test('the Nuxt payload decodes, wrappers and shared references included', () => {
  const data = decodeNuxtData(html);
  const { list } = data['events/RBNvo1WzZ4oRRq0W9'].payload;
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 672);
  assert.equal(list[0].car, undefined);
  assert.equal(list[0].track, list[1].track); // one object, referenced twice
  assert.deepEqual(list[0].settingsChips, [{ key: 'time', label: '17:00' }]);
  assert.throws(() => decodeNuxtData('<html></html>'), /no __NUXT_DATA__/);
});

test('dg-edge times are Central European wall clock, turned into UTC across the DST change', () => {
  const [live, later] = decodeNuxtData(html)['events/RBNvo1WzZ4oRRq0W9'].payload.list.map(normalizeEvent);
  // CEST (UTC+2) in early October...
  assert.equal(live.startsAt, '2026-10-08T07:00:00.000Z');
  assert.equal(live.endsAt, '2026-10-22T06:59:59.000Z');
  // ...CET (UTC+1) after 25 October: the same 06:59:59 UTC close.
  assert.equal(later.startsAt, '2026-10-29T06:59:59.000Z');
  assert.equal(later.endsAt, '2026-11-05T06:59:59.000Z');
  assert.deepEqual(
    { dgId: live.dgId, car: live.car, status: live.status, settings: live.settings, leadMs: live.leadMs, endDate: live.endDate },
    { dgId: '672', car: 'GR.1', status: 'live', settings: ['17:00'], leadMs: 105285, endDate: '2026-10-22' }
  );
  assert.equal(live.url, 'https://www.dg-edge.com/events/time-trials/gr-1-dragon-trail-gardens/672');
  assert.equal(later.status, 'ended');
});

const trial = (track, startDate, endDate) => ({ track, startDate, endDate });

test('a dg-edge trial finds its site event despite the different track names', () => {
  assert.ok(sameTimeTrial(trial('SUGO International Racing Course', '2026-10-15', '2026-10-29'), trial('Sportsland SUGO', '2026-10-15', '2026-10-29')));
  assert.ok(
    sameTimeTrial(trial('Brands Hatch - Grand Prix Circuit', '2026-10-01', '2026-10-15'), trial('Brands Hatch Grand Prix Circuit', '2026-10-01', '2026-10-15'))
  );
  // Two Time Trials that opened together on 24 Sep 2026 never cross-match.
  const sainteCroix = trial('Circuit de Sainte-Croix - Layout B Reverse', '2026-09-24', '2026-10-08');
  const atlanta = trial('Michelin Raceway Road Atlanta', '2026-09-24', '2026-10-08');
  assert.ok(sameTimeTrial(sainteCroix, trial('Circuit de Sainte-Croix - B Reverse', '2026-09-24', '2026-10-08')));
  assert.ok(!sameTimeTrial(sainteCroix, atlanta));
  // Same track, another fortnight.
  assert.ok(!sameTimeTrial(trial('Dragon Trail - Gardens', '2026-10-08', '2026-10-22'), trial('Dragon Trail - Gardens', '2025-10-08', '2025-10-22')));
});
