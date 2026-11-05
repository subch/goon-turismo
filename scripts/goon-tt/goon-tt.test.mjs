// npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createOcr, readRecordsScreen, parsePp, parseRecordDate, parseNameLine, badgeColour } from './records-screen.mjs';
import { lapToMs, msToLap, gapText, board, status, runningTt } from './standings.mjs';
import { checkLap, sameCar, carKey } from './check-lap.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const TT = {
  car: "Nissan Fairlady 240ZG (HS30) '71",
  pp: 605.25,
  tyres: 'SS',
  startDate: '2026-11-04',
  endDate: '2026-11-18',
};

const tyre = (code) => ({ code, letters: code, colour: 'red' });
const row = (over = {}) => ({
  rank: 1,
  car: "Nissan Fairlady 240ZG (HS30) '71",
  pp: 605.25,
  ppBadge: 605.25,
  timeMs: 87864,
  date: parseRecordDate('11/4/2026 12:23'),
  tyres: { front: tyre('SS'), rear: tyre('SS') },
  ...over,
});
const reading = (...rows) => ({ ok: true, rows, selected: {} });

test('lap times parse and print the way GT7 shows them', () => {
  assert.equal(lapToMs('1:27.864'), 87864);
  assert.equal(lapToMs('58.123'), 58123);
  assert.equal(lapToMs('--:--.---'), null);
  assert.equal(msToLap(87864), '1:27.864');
  assert.equal(msToLap(64400), '1:04.400');
  assert.equal(msToLap(58123), '58.123');
});

test('PP comes out of a badge or a name line, with or without a group', () => {
  assert.equal(parsePp('PP 605.25'), 605.25);
  assert.equal(parsePp('Gr.3 / PP 687.44'), 687.44);
  assert.equal(parsePp('pp 569.31'), 569.31);
  assert.equal(parsePp('Overall'), null);
  assert.deepEqual(parseNameLine("Nissan Skyline Super Silhouette Group 5 '84 Gr.3 / PP 687.44"), {
    car: "Nissan Skyline Super Silhouette Group 5 '84",
    pp: 687.44,
  });
  assert.equal(parseNameLine("Honda Civic Si Group A version '87 (PP 593.52").car, "Honda Civic Si Group A version '87");
  assert.equal(parseNameLine('--- '), null);
});

test("a record's date keeps both readings when day and month could swap", () => {
  assert.deepEqual(parseRecordDate('11/4/2026 22:34'), {
    text: '11/4/2026 22:34',
    time: '22:34',
    monthFirst: '2026-11-04',
    dayFirst: '2026-04-11',
  });
  assert.equal(parseRecordDate('10/17/2026 10:07').dayFirst, null);
  assert.equal(parseRecordDate('10/16/2026 8:49').time, '08:49');
});

test('badge rings are named by colour', () => {
  assert.equal(badgeColour([230, 40, 45]), 'red');
  assert.equal(badgeColour([230, 200, 40]), 'yellow');
  assert.equal(badgeColour([225, 225, 230]), 'white');
  assert.equal(badgeColour([40, 110, 230]), 'blue');
  assert.equal(badgeColour([20, 20, 25]), null);
});

test('the same car matches through curly quotes, a missing make and an OCR slip', () => {
  assert.equal(carKey("Fairlady 240ZG (HS30) ‘71"), 'fairlady240zghs3071');
  assert.ok(sameCar("Nissan Fairlady 240ZG (HS30) ‘71", TT.car));
  assert.ok(sameCar("Fairlady 240ZG (HS30) '71", TT.car));
  assert.ok(sameCar("Nissan Fairlady 240Z6 (HS30) '71", TT.car));
  assert.ok(!sameCar("Nissan Fairlady Z 432 (PS30) '69", TT.car));
  assert.ok(!sameCar("Nissan Fairlady 240ZG (HS30) '72", TT.car));
  assert.ok(!sameCar("Dallara SF23 Super Formula/Toyota '23", TT.car));
});

test('a row that passes every rule is the lap', () => {
  const result = checkLap(reading(row()), TT, { typedMs: 87864 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.lap, {
    timeMs: 87864,
    time: '1:27.864',
    setOn: '2026-11-04',
    setAt: '12:23',
    rank: 1,
    car: "Nissan Fairlady 240ZG (HS30) '71",
    pp: 605.25,
    tyres: 'SS',
  });
});

test('only the TT car counts, and the fastest passing run of it', () => {
  const other = row({ rank: 1, car: "Dallara SF23 Super Formula/Toyota '23", pp: 962.29, ppBadge: 962.29, timeMs: 64400 });
  const slower = row({ rank: 3, timeMs: 88100 });
  const result = checkLap(reading(other, row({ rank: 2 }), slower), TT);
  assert.equal(result.lap.rank, 2);
  assert.equal(result.lap.timeMs, 87864);
});

test('each broken rule is named', () => {
  const fail = (over, opts) => checkLap(reading(row(over)), TT, opts).reasons;
  assert.deepEqual(fail({ ppBadge: 615.23, pp: 615.23 }), ['PP reads 615.23, this TT is 605.25']);
  assert.deepEqual(fail({ tyres: { front: tyre('RH'), rear: tyre('RH') } }), ['tyres read RH / RH, this TT is SS / SS']);
  assert.deepEqual(fail({}, { typedMs: 87684 }), ['the lap reads 1:27.864, not the 1:27.684 you typed']);
  assert.deepEqual(fail({ date: parseRecordDate('10/15/2026 20:12') }), ['set 10/15/2026 20:12, before this TT opened on 4 Nov 2026']);
  assert.deepEqual(fail({ date: parseRecordDate('11/20/2026 20:12') }), ['set 11/20/2026 20:12, outside this TT\'s 4 Nov 2026 to 18 Nov 2026']);
  assert.deepEqual(fail({ timeMs: null, tyres: { front: tyre(null), rear: tyre('SS') } }), [
    "couldn't read the tyre badges",
    "couldn't read the lap time",
  ]);
});

test('a PP misread on the name line is outvoted by the badge', () => {
  assert.equal(checkLap(reading(row({ pp: 603.25 })), TT).ok, true);
});

test('a screenshot without the car says what it does show', () => {
  const result = checkLap(reading(row({ car: "Ferrari F355 Berlinetta '94" })), TT);
  assert.deepEqual(result.reasons, [`no ${TT.car} on this screenshot (it shows Ferrari F355 Berlinetta '94)`]);
  assert.deepEqual(checkLap({ ok: false, reason: 'the image is 1170 x 1501, not a 16:9 console screenshot' }, TT).reasons, [
    'the image is 1170 x 1501, not a 16:9 console screenshot',
  ]);
});

// The reader itself, on two real 1080p captures from 4 Nov 2026. About ten
// seconds: Tesseract reads each field separately.
test('OCR reads the feature car off real records screens', { timeout: 120_000 }, async () => {
  const ocr = await createOcr();
  try {
    const wantRow = ({ car }) => sameCar(car, TT.car);

    const rammy = await readRecordsScreen(path.join(FIXTURES, 'records-dog_nougat-1080p.jpg'), { ocr, wantRow });
    assert.equal(rammy.ok, true);
    assert.deepEqual(
      rammy.rows.map((r) => r.car),
      [
        "Dallara SF23 Super Formula/Toyota '23",
        "Nissan Fairlady 240ZG (HS30) '71",
        "Nissan Skyline Super Silhouette Group 5 '84",
        "Honda Civic Si Group A version '87",
        "Ferrari F355 Berlinetta '94",
      ]
    );
    const fromRammy = checkLap(rammy, TT, { typedMs: 87864 });
    assert.equal(fromRammy.ok, true, fromRammy.reasons?.join('; '));
    assert.equal(fromRammy.lap.rank, 2);
    assert.equal(fromRammy.lap.setAt, '12:23');

    const travis = await readRecordsScreen(path.join(FIXTURES, 'records-travis-1080p.jpg'), { ocr, wantRow });
    assert.equal(travis.rows.length, 1, 'the empty rows below the record are not records');
    const fromTravis = checkLap(travis, TT);
    assert.equal(fromTravis.ok, true, fromTravis.reasons?.join('; '));
    assert.equal(fromTravis.lap.time, '1:28.965');
    assert.equal(travis.selected.pp, 605.25);

    // The same screenshot held to the tune sheet's PP and tyres fails on both.
    assert.deepEqual(checkLap(travis, { ...TT, pp: 615.23, tyres: 'RH' }).reasons, [
      'PP reads 605.25, this TT is 615.23',
      'tyres read SS / SS, this TT is RH / RH',
    ]);
  } finally {
    await ocr.terminate();
  }
});

const lap = (psn, timeMs, submittedAt = '2026-11-05T00:00:00Z') => ({ psn, timeMs, submittedAt });

test("the board keeps each driver's best lap and scores it off the leader", () => {
  const rows = board({ laps: [lap('travis', 88965), lap('dog_nougat', 87864), lap('travis', 89500)] });
  assert.deepEqual(
    rows.map(({ place, psn, time, gapMs, points, laps }) => ({ place, psn, time, gap: gapText(gapMs), points, laps })),
    [
      { place: 1, psn: 'dog_nougat', time: '1:27.864', gap: '', points: 100, laps: 1 },
      { place: 2, psn: 'travis', time: '1:28.965', gap: '+1.101', points: 87, laps: 2 },
    ]
  );
  assert.deepEqual(board({ laps: [] }), []);
});

test('a Goon TT is upcoming, running, then closed', () => {
  const tt = { opensAt: '2026-11-04T06:00:00Z', closesAt: '2026-11-19T05:59:00Z' };
  assert.equal(status(tt, new Date('2026-11-04T05:59:00Z')), 'upcoming');
  assert.equal(status(tt, new Date('2026-11-10T12:00:00Z')), 'running');
  assert.equal(status(tt, new Date('2026-11-19T05:59:00Z')), 'closed');
  assert.equal(runningTt([tt], new Date('2026-11-10T12:00:00Z')), tt);
  assert.equal(runningTt([tt], new Date('2026-12-01T00:00:00Z')), null);
});
