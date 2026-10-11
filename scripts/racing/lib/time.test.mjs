// npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { wallTimeToUtc } from './time.mjs';
import { sessionStartUtc } from '../series/motogp.mjs';

test('wallTimeToUtc converts a zone wall-clock time to UTC', () => {
  assert.equal(wallTimeToUtc('2026-10-11T15:00:00', 'Asia/Makassar'), '2026-10-11T07:00:00.000Z');
  assert.equal(wallTimeToUtc('2026-09-19T19:30:00', 'America/New_York'), '2026-09-19T23:30:00.000Z');
});

test('wallTimeToUtc accepts the upper-case zone names MotoGP sends', () => {
  assert.equal(wallTimeToUtc('2026-10-25T14:00:00', 'AUSTRALIA/MELBOURNE'), '2026-10-25T03:00:00.000Z');
});

test('wallTimeToUtc follows DST', () => {
  assert.equal(wallTimeToUtc('2026-11-29T14:00:00', 'Europe/Madrid'), '2026-11-29T13:00:00.000Z');
  assert.equal(wallTimeToUtc('2026-04-26T14:00:00', 'Europe/Madrid'), '2026-04-26T12:00:00.000Z');
  // An hour and a half after US clocks go forward: already EDT.
  assert.equal(wallTimeToUtc('2026-03-08T03:30:00', 'America/New_York'), '2026-03-08T07:30:00.000Z');
});

test('wallTimeToUtc returns null rather than guessing', () => {
  assert.equal(wallTimeToUtc(null, 'Asia/Makassar'), null);
  assert.equal(wallTimeToUtc('2026-10-11T15:00:00', null), null);
  assert.equal(wallTimeToUtc('2026-10-11T15:00:00', 'Mars/Olympus'), null);
  assert.equal(wallTimeToUtc('not a date', 'Asia/Makassar'), null);
});

// The results API stamps circuit-local times with a +00:00 offset: the 2026
// Indonesian GP Moto2 race ran at 13:15 Lombok time, 05:15 UTC.
test('MotoGP session dates are circuit-local despite their +00:00 offset', () => {
  assert.equal(sessionStartUtc('2026-10-11T13:15:00+00:00', 'ASIA/MAKASSAR'), '2026-10-11T05:15:00.000Z');
  assert.equal(sessionStartUtc('2026-10-11T13:15:00+00:00', undefined), null);
  assert.equal(sessionStartUtc(null, 'ASIA/MAKASSAR'), null);
});
