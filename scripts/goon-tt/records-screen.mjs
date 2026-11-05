/**
 * Reads a GT7 records screen -- the lap list behind World Circuits' Time
 * Trial, with the Overall / Gr.1 ... PP 100 tabs -- with Tesseract OCR.
 *
 * The screen is a fixed layout, so nothing is searched for: every field is
 * cut out by its position in a 2000 x 1125 frame, scaled up, and read on its
 * own with only the characters it can hold. That works on a console capture
 * at any 16:9 size (the PS5 shares 1080p and 4K); a photo of a TV is not one
 * and is refused rather than guessed at.
 *
 * Tesseract here is tesseract.js (WebAssembly) with the English data from
 * @tesseract.js-data/eng, so it runs the same on the workstation and in
 * goon-scraper, with no system packages and no network.
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorker, PSM } from 'tesseract.js';
import { Jimp } from 'jimp';
import { lapToMs } from './standings.mjs';

const require = createRequire(import.meta.url);
const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');

export const FRAME = { w: 2000, h: 1125 };

// Where things sit in the 2000 x 1125 frame. The 13 visible rows are 62.5
// apart, the first centred at y 249.
const ROWS = 13;
const ROW_Y0 = 249;
const ROW_PITCH = 62.5;
const ROW_H = 46;
const AT = {
  header: { x: 290, y: 184, w: 1430, h: 30 }, // "Car ... Time ... Date & Time"
  name: { x: 340, w: 860 }, // the car's name and its PP badge
  pill: { x: 1000, w: 196 }, // the PP badge alone ("PP 605.25", "Gr.3 / PP 687.44")
  time: { x: 1310, w: 205 },
  date: { x: 1520, w: 200 },
  tyres: [1227, 1271], // centres of the front and rear tyre badges
  tyreR: 19,
  // The top bar: whichever car is selected, which need not be the record's.
  selectedName: { x: 990, y: 13, w: 330, h: 36 },
  selectedSpecs: { x: 990, y: 44, w: 330, h: 30 },
  selectedPp: { x: 1316, y: 24, w: 114, h: 36 },
};

const DIGITS = '0123456789';
const TYRE_LETTERS = 'CSRHMIWD';
// A badge's colour is its compound's hardness: GT7 rings hard white, medium
// yellow, soft red; wet tyres are blue and intermediates green.
const HARDNESS = { white: 'H', yellow: 'M', red: 'S' };

/** One Tesseract worker, reused for every field; terminate() it when done. */
export async function createOcr() {
  return createWorker('eng', 1, { langPath: LANG_PATH, cachePath: path.join(os.tmpdir(), 'goon-tt-ocr'), gzip: true });
}

const rowRect = (i, { x, w }) => ({ x, y: ROW_Y0 + i * ROW_PITCH - ROW_H / 2, w, h: ROW_H });

/** The frame rectangle in the source image's own pixels. */
function toSource(img, r) {
  const k = img.bitmap.width / FRAME.w;
  const x = Math.max(0, Math.round(r.x * k));
  const y = Math.max(0, Math.round(r.y * k));
  return {
    x,
    y,
    w: Math.min(img.bitmap.width - x, Math.round(r.w * k)),
    h: Math.min(img.bitmap.height - y, Math.round(r.h * k)),
  };
}

/**
 * Cut a field out, scaled to three times the frame (text about 60 px tall,
 * where Tesseract is happiest), as dark text on white with a margin. GT7's
 * text is light on dark, so it is inverted; `bright` instead binarises it,
 * keeping only near-white pixels as ink, which drops the scenery that shows
 * through the rows. A PP badge is the other way round (dark on a light pill),
 * so it is used as it comes.
 */
function cut(img, r, { mode = 'invert', scale = 3 } = {}) {
  const s = toSource(img, r);
  const field = img.clone().crop(s).resize({ w: Math.round(r.w * scale) }).greyscale();
  const d = field.bitmap.data;
  // Stretch the field's own range to full black-to-white first: the column
  // headings are dim grey on near-black, too faint for Tesseract as they come.
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
  const total = d.length / 4;
  const pct = (p) => {
    for (let v = 0, seen = 0; v < 256; v++) if ((seen += hist[v]) >= total * p) return v;
    return 255;
  };
  const lo = pct(0.02);
  const hi = Math.max(pct(0.995), lo + 1);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.min(255, Math.max(0, Math.round(((d[i] - lo) / (hi - lo)) * 255)));
    const out = mode === 'bright' ? (v >= 170 ? 0 : 255) : mode === 'invert' ? 255 - v : v;
    d[i] = d[i + 1] = d[i + 2] = out;
  }
  const ink = mode === 'pill' ? pillOnly(field) : field;
  if (!ink) return null;
  const pad = 16;
  const page = new Jimp({ width: ink.bitmap.width + pad * 2, height: ink.bitmap.height + pad * 2, color: 0xffffffff });
  page.composite(ink, pad, pad);
  return page;
}

/**
 * A PP badge cut to the light pill itself. Left as it comes, the dark row
 * beside a short badge reads to Tesseract as one more huge character and the
 * whole line is lost. The pill's rounded ends are trimmed too. Null when
 * there is no pill, which is how an empty row is told apart: every record has
 * a PP badge, and OCR reads an empty row's dashes as anything at all.
 */
function pillOnly(field) {
  const { width, height, data } = field.bitmap;
  const light = (x, y) => data[(y * width + x) * 4] >= 200;
  const cols = [];
  for (let x = 0; x < width; x++) {
    let n = 0;
    for (let y = 0; y < height; y++) if (light(x, y)) n++;
    if (n > height * 0.3) cols.push(x);
  }
  if (cols.length < height) return null;
  const rows = [];
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (const x of cols) if (light(x, y)) n++;
    if (n > cols.length * 0.5) rows.push(y);
  }
  const top = rows[0] ?? 0;
  const bottom = rows.at(-1) ?? height - 1;
  const inset = Math.round((bottom - top) * 0.3);
  const left = cols[0] + inset;
  const right = cols.at(-1) - inset;
  return field.clone().crop({ x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) });
}

async function read(ocr, page, { psm = PSM.SINGLE_LINE, chars = '' } = {}, debug, name) {
  if (!page) return '';
  await ocr.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: chars });
  const png = await page.getBuffer('image/png');
  if (debug) await writeFile(path.join(debug, `${name}.png`), png);
  const { data } = await ocr.recognize(png);
  return data.text.replace(/\s+/g, ' ').trim();
}

/** The PP figure out of a badge or name line: "PP 605.25", "Gr.3 / PP 687.44". */
export function parsePp(text) {
  const m = String(text ?? '').match(/P\s*P\s*(\d{2,4}\.\d{2})/i);
  return m ? Number(m[1]) : null;
}

/**
 * The record's date as the console printed it: "11/4/2026 22:34". The order
 * of day and month follows the console's region, so both readings are kept
 * and the caller decides which one the Time Trial's window allows.
 */
export function parseRecordDate(text) {
  const m = String(text ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, a, b, y, hh, mm] = m.map(Number);
  const iso = (mo, d) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
  const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  return { text: m[0], time, monthFirst: iso(a, b), dayFirst: iso(b, a) };
}

/** Name and PP out of a row's name line; a line of dashes is an empty row. */
export function parseNameLine(text) {
  const t = String(text ?? '').trim();
  if (!t || /^[-—–_.\s]+$/.test(t) || !/[a-z]{2}/i.test(t)) return null;
  const at = t.search(/(?:Gr\.?\s*\S+\s*\/\s*)?P\s*P\s*\d/i);
  return { car: cleanName(at > 0 ? t.slice(0, at) : t), pp: parsePp(t) };
}

/** A car name without the stray marks OCR picks up at its edges ("'87 (", "| Dallara"). */
export function cleanName(text) {
  return String(text ?? '')
    .replace(/[|[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s(—–-]+$/, '')
    .replace(/^[\s)—–-]+/, '');
}

/** Name a ring colour from its average RGB. */
export function badgeColour([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 90) return null;
  if (max - min < 45) return 'white';
  if (r >= g && r >= b) return g > 0.6 * r && b < 0.6 * r ? 'yellow' : 'red';
  if (b >= r && b >= g) return 'blue';
  return 'green';
}

/**
 * A tyre badge: its letters (SS, RH, W...) and its ring's colour. The colour
 * is the more reliable of the two for hardness, so a two-letter read whose
 * second letter disagrees with it takes the colour's.
 */
async function readTyre(ocr, img, cx, cy, debug, name) {
  const R = AT.tyreR;
  const s = toSource(img, { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R });
  const sum = [0, 0, 0];
  let n = 0;
  img.scan(s.x, s.y, s.w, s.h, (x, y, idx) => {
    const dx = (x - s.x) / s.w - 0.5;
    const dy = (y - s.y) / s.h - 0.5;
    const rr = Math.sqrt(dx * dx + dy * dy);
    if (rr < 0.38 || rr > 0.5) return; // the ring only
    const d = img.bitmap.data;
    if (Math.max(d[idx], d[idx + 1], d[idx + 2]) < 110) return; // the dark gaps around it
    sum[0] += d[idx];
    sum[1] += d[idx + 1];
    sum[2] += d[idx + 2];
    n++;
  });
  const colour = n ? badgeColour(sum.map((v) => v / n)) : null;
  // Letters only, inside the ring.
  const inner = cut(img, { x: cx - R * 0.62, y: cy - R * 0.5, w: R * 1.24, h: R }, { mode: 'bright', scale: 6 });
  const letters = (await read(ocr, inner, { psm: PSM.SINGLE_WORD, chars: TYRE_LETTERS }, debug, name)).replace(/[^A-Z]/g, '');
  let code = letters;
  const hard = HARDNESS[colour];
  if (letters.length === 2 && 'CSR'.includes(letters[0]) && hard) code = letters[0] + hard;
  else if (colour === 'blue') code = 'W';
  else if (colour === 'green') code = 'IM';
  return { code: code || null, letters, colour };
}

/**
 * Read one screenshot. `wantRow({ car, pp })` picks the rows worth reading in
 * full (lap, date, tyres); every row's car and PP are read regardless, so a
 * refusal can say what the screenshot does show.
 *
 * Resolves { ok: true, rows, selected } or { ok: false, reason }.
 */
export async function readRecordsScreen(image, { ocr, wantRow = () => true, debugDir = null } = {}) {
  const img = await Jimp.read(image);
  const { width, height } = img.bitmap;
  if (Math.abs(height / width - FRAME.h / FRAME.w) > 0.01) {
    return { ok: false, reason: `the image is ${width} x ${height}, not a 16:9 console screenshot` };
  }
  if (width < 1280) return { ok: false, reason: `the image is only ${width} pixels wide; post the full-size console screenshot` };
  if (debugDir) await mkdir(debugDir, { recursive: true });

  const header = await read(ocr, cut(img, AT.header), {}, debugDir, 'header');
  if (!/\bCar\b/i.test(header) || !/Time/i.test(header)) {
    return { ok: false, reason: "it doesn't look like a GT7 records screen (no Car / Time / Date & Time headings)" };
  }

  const rows = [];
  for (let i = 0; i < ROWS; i++) {
    // Records fill from the top, so the first row without a PP badge ends them.
    const pillPage = cut(img, rowRect(i, AT.pill), { mode: 'pill' });
    if (!pillPage) break;
    const line = await read(ocr, cut(img, rowRect(i, AT.name)), {}, debugDir, `row${i + 1}-name`);
    const named = parseNameLine(line) ?? { car: '', pp: null };
    const row = { rank: i + 1, car: named.car, pp: named.pp, line };
    if (wantRow(row)) {
      const pill = await read(ocr, pillPage,{ chars: `${DIGITS}PGr./ ` }, debugDir, `row${i + 1}-pp`);
      const time = await read(ocr, cut(img, rowRect(i, AT.time), { mode: 'bright' }), { chars: `${DIGITS}:.` }, debugDir, `row${i + 1}-time`);
      const date = await read(ocr, cut(img, rowRect(i, AT.date), { mode: 'bright' }), { chars: `${DIGITS}/: ` }, debugDir, `row${i + 1}-date`);
      const cy = ROW_Y0 + i * ROW_PITCH;
      const front = await readTyre(ocr, img, AT.tyres[0], cy, debugDir, `row${i + 1}-tyre-front`);
      const rear = await readTyre(ocr, img, AT.tyres[1], cy, debugDir, `row${i + 1}-tyre-rear`);
      Object.assign(row, {
        ppBadge: parsePp(pill),
        timeMs: lapToMs(time),
        timeText: time,
        date: parseRecordDate(date),
        dateText: date,
        tyres: { front, rear },
      });
    }
    rows.push(row);
  }

  const selected = {
    car: cleanName(await read(ocr, cut(img, AT.selectedName), {}, debugDir, 'selected-name')),
    specs: await read(ocr, cut(img, AT.selectedSpecs), {}, debugDir, 'selected-specs'),
    pp: parsePp(await read(ocr, cut(img, AT.selectedPp, { mode: 'pill' }), { chars: `${DIGITS}P. ` }, debugDir, 'selected-pp')),
  };
  return { ok: true, rows, selected };
}
