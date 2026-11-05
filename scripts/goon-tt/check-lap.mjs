/**
 * Does a records-screen reading (records-screen.mjs) prove a lap for a Goon
 * TT? The OCR only reads; every rule lives here, so it can be tested without
 * images.
 *
 * A Goon TT (data/goon-tt/<id>.json) fixes the car, its PP to the hundredth,
 * the tyre compound front and rear, and a window of dates. A screenshot
 * proves a lap when one of its rows is that car and passes every rule; when
 * several do (the same car run more than once), the fastest counts.
 */
import { msToLap } from './records-screen.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const showDate = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** Letters and digits only, curly quotes and all: "Fairlady 240ZG (HS30) ‘71" -> "fairlady240zghs3071". */
export function carKey(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/**
 * Same car, allowing a slip or two of OCR ("240ZG" as "240Z6"). The records
 * list prints the make ("Nissan Fairlady..."), the top bar does not, so a
 * name without its make matches too. Model years must still agree: they are
 * the last characters, and two slips there would be a different car.
 */
export function sameCar(read, wanted) {
  const a = carKey(read);
  const b = carKey(wanted);
  if (!a || !b) return false;
  if (a === b || b.endsWith(a) || a.endsWith(b)) return a.length >= 8;
  return a.slice(-2) === b.slice(-2) && editDistance(a, b) <= Math.max(1, Math.floor(b.length * 0.08));
}

const tyrePair = (t) => `${t.front?.code ?? '?'} / ${t.rear?.code ?? '?'}`;

/** Every rule one row breaks, in words a driver can act on. */
function problems(row, tt, typedMs) {
  const out = [];
  const pps = [row.ppBadge, row.pp].filter((v) => v != null);
  if (!pps.length) out.push("couldn't read the PP badge");
  else if (!pps.some((v) => Math.abs(v - tt.pp) < 0.005)) out.push(`PP reads ${pps[0].toFixed(2)}, this TT is ${tt.pp.toFixed(2)}`);

  const tyres = row.tyres ?? {};
  if (!tyres.front?.code || !tyres.rear?.code) out.push("couldn't read the tyre badges");
  else if (tyres.front.code !== tt.tyres || tyres.rear.code !== tt.tyres) {
    out.push(`tyres read ${tyrePair(tyres)}, this TT is ${tt.tyres} / ${tt.tyres}`);
  }

  if (row.timeMs == null) out.push("couldn't read the lap time");
  else if (typedMs != null && row.timeMs !== typedMs) out.push(`the lap reads ${msToLap(row.timeMs)}, not the ${msToLap(typedMs)} you typed`);

  const set = setDate(row, tt);
  if (!row.date) out.push("couldn't read the date the lap was set");
  else if (!set) {
    const shown = row.date.monthFirst ?? row.date.dayFirst;
    out.push(
      shown && shown < tt.startDate
        ? `set ${row.date.text}, before this TT opened on ${showDate(tt.startDate)}`
        : `set ${row.date.text}, outside this TT's ${showDate(tt.startDate)} to ${showDate(tt.endDate)}`
    );
  }
  return out;
}

/** The lap's date: whichever reading of the console's date falls in the window (US consoles print month first). */
function setDate(row, tt) {
  const inside = (iso) => iso && iso >= tt.startDate && iso <= tt.endDate;
  if (!row.date) return null;
  if (inside(row.date.monthFirst)) return row.date.monthFirst;
  if (inside(row.date.dayFirst)) return row.date.dayFirst;
  return null;
}

/**
 * Check a reading against a Goon TT. `typedMs` is the lap the driver typed
 * with /goonttsubmit; a right-click submission has none and takes the lap
 * off the screenshot.
 *
 * Returns { ok: true, lap } with lap = { timeMs, time, setOn, setAt, rank,
 * car, pp, tyres }, or { ok: false, reasons } -- each reason a short phrase.
 */
export function checkLap(reading, tt, { typedMs = null } = {}) {
  if (!reading?.ok) return { ok: false, reasons: [reading?.reason ?? "couldn't read the screenshot"] };
  const rows = reading.rows.filter((r) => sameCar(r.car, tt.car));
  if (!rows.length) {
    const seen = reading.rows.map((r) => r.car).filter(Boolean);
    return {
      ok: false,
      reasons: [`no ${tt.car} on this screenshot${seen.length ? ` (it shows ${seen.join(', ')})` : ''}`],
    };
  }

  const judged = rows.map((row) => ({ row, problems: problems(row, tt, typedMs) }));
  const passing = judged.filter((j) => !j.problems.length).sort((a, b) => a.row.timeMs - b.row.timeMs);
  if (!passing.length) {
    const closest = judged.sort((a, b) => a.problems.length - b.problems.length)[0];
    return { ok: false, reasons: closest.problems };
  }

  const { row } = passing[0];
  return {
    ok: true,
    lap: {
      timeMs: row.timeMs,
      time: msToLap(row.timeMs),
      setOn: setDate(row, tt),
      setAt: row.date.time,
      rank: row.rank,
      car: row.car,
      pp: tt.pp,
      tyres: tt.tyres,
    },
  };
}
