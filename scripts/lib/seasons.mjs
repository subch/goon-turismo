// Shared season-matching helpers used by every scraper that needs to figure
// out which season (data/seasons.json) a scraped date falls into.

/**
 * Find the season whose [startDate, endDate] range (ISO YYYY-MM-DD, endDate
 * null meaning open-ended/current) contains the given ISO date. Returns null
 * if the date falls in a gap between tracked seasons.
 */
export function seasonForDate(iso, seasons) {
  return seasons.find((s) => iso >= s.startDate && (!s.endDate || iso <= s.endDate)) ?? null;
}

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Parse "6 August 2026" / "06 Aug 2026" (day, full or abbreviated month
 * name, year -- the two date formats seen across dg-edge.com and
 * GT-GridStats) into an ISO YYYY-MM-DD string for comparison against season
 * boundaries. Returns null if the string doesn't match.
 */
export function humanDateToIso(d) {
  if (!d) return null;
  const m = d.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${mo}-${m[1].padStart(2, '0')}`;
}
