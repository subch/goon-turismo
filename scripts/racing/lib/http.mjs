// Shared, deliberately polite HTTP helpers for the racing adapters.
//
// Every source here is a public page or the JSON endpoint behind one, hit at
// low volume (a few dozen requests per sync, spaced out) with an honest
// User-Agent that says who we are and where to complain. Nothing is fetched
// that a browser wouldn't fetch to show the same page, and nothing is fetched
// live during a session -- the sync runs on a fixed cron, not on demand.

export const USER_AGENT =
  'Mozilla/5.0 (compatible; GoonTurismoBot/1.0; +https://goon-turismo.com) - low-volume results sync for a private fan site';

const DEFAULT_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let lastRequestAt = 0;

/**
 * fetch() with a UA, a minimum spacing between requests, and one retry on a
 * 429/5xx. Throws on any other non-2xx so a broken source fails the adapter
 * loudly instead of silently writing an empty season.
 */
export async function request(url, { headers = {}, method = 'GET', body, delayMs = DEFAULT_DELAY_MS, retries = 2 } = {}) {
  const wait = lastRequestAt + delayMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, { method, body, headers: { 'User-Agent': USER_AGENT, ...headers }, redirect: 'follow' });
    } catch (err) {
      if (attempt++ < retries) {
        await sleep(1500 * attempt);
        continue;
      }
      throw new Error(`${method} ${url}: ${err.message}`);
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt++ < retries) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      await sleep(Math.max(retryAfter * 1000, 2000 * attempt));
      continue;
    }
    throw new Error(`${method} ${url}: HTTP ${res.status}`);
  }
}

export async function getJson(url, opts) {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts?.headers || {}) } });
  return res.json();
}

export async function getText(url, opts) {
  const res = await request(url, opts);
  return res.text();
}

/** Minimal HTML entity decode for the handful of entities these sites emit. */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Strip tags and collapse whitespace. */
export function textOf(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
