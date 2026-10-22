// GT7 Time Trial details from dg-edge.com, for the Discord poster
// (scripts/post-discord.mjs): which Time Trials are live, their exact start
// and end, car, tyres and race settings, and the world #1 the GT7 medal
// cut-offs hang off. dg-edge refreshes its top 5,000 several times a day,
// which is why the posts use it over GT-GridStats. The crew's own laps still
// come from data/ (sync-gridstats.mjs); nothing here writes anything.
//
// dg-edge stopped being a source for the site's data on 2026-09-28 because it
// shows no per-player times. Event details it still has, and those are all
// this reads.
//
// The pages are Nuxt: everything shown is also in the page's __NUXT_DATA__
// payload, which is read instead of the markup (checked 2026-10-22):
//   /events/time-trials        payload.list: the ~12 newest Time Trials,
//                              live and ended, with their lead time
//   /events/time-trials/<slug> payload.event + .leader (name) + .stats
//                              (medal times and how many drivers hold each)
// robots.txt allows /events/. Cloudflare challenges generic clients but
// serves the site's own identified User-Agent; if that ever changes, this
// fails loudly rather than trying to look like a browser.
import * as cheerio from 'cheerio';
import { parseTimeToMs } from './points.mjs';
import { trackTokens, daysBetween } from './seasons.mjs';
import { wallTimeToUtc } from '../racing/lib/time.mjs';

const BASE = 'https://www.dg-edge.com';
const USER_AGENT =
  'Mozilla/5.0 (compatible; GoonTurismoBot/1.0; +https://goon-turismo.com) - fetches public pages only, on behalf of the goon-turismo.com fan tracker';
const REQUEST_DELAY_MS = 1500; // a free community site, be polite
// dg-edge stamps times in its own Central European wall clock: a forum post
// at "2026-10-15 10:54:21" carries createDateUtc 08:54:21+00:00.
const DG_EDGE_ZONE = 'Europe/Rome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

async function fetchPage(pathname) {
  const wait = lastRequestAt + REQUEST_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const res = await fetch(BASE + pathname, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status} ${res.statusText}`);
  return res.text();
}

// Nuxt serialises its payload with `devalue`: one flat array in which every
// object/array holds indices into that same array, and a few types are tagged
// ["Reactive", i], ["Set", ...] and so on. Negative indices are constants.
const WRAPPERS = new Set(['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef']);

/** The page's `data` object from its __NUXT_DATA__ payload. */
export function decodeNuxtData(html) {
  const json = cheerio.load(html)('script#__NUXT_DATA__').html();
  if (!json) throw new Error('no __NUXT_DATA__ payload on the page -- dg-edge has changed');
  const flat = JSON.parse(json);
  const done = new Map();
  const hydrate = (i) => {
    if (i < 0) return i === -1 || i === -2 ? undefined : null; // -1 undefined, -2 hole; NaN/Infinity are never data here
    if (done.has(i)) return done.get(i);
    const v = flat[i];
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') {
      // A tagged type. Plain arrays only ever hold indices, never strings.
      const [tag, ...rest] = v;
      let out = null;
      if (WRAPPERS.has(tag)) out = hydrate(rest[0]);
      else if (tag === 'Set') out = rest.map(hydrate);
      else if (tag === 'Date') out = rest[0];
      done.set(i, out);
      return out;
    }
    const out = Array.isArray(v) ? [] : {};
    done.set(i, out);
    for (const [k, idx] of Object.entries(v)) out[k] = hydrate(idx);
    return out;
  };
  return hydrate(0)?.data ?? {};
}

/** The one `data` entry that carries `payload.<key>` (the entry names are hashes). */
function payloadWith(data, key) {
  const entry = Object.values(data).find((e) => e?.payload?.[key] !== undefined);
  if (!entry) throw new Error(`no payload with "${key}" on the page -- dg-edge has changed`);
  return entry.payload;
}

function toUtc(dgTime) {
  return dgTime ? wallTimeToUtc(String(dgTime).replace(' ', 'T'), DG_EDGE_ZONE) : null;
}

/** One listing/detail `event` record, flattened to what the posts use. */
export function normalizeEvent(e) {
  const startsAt = toUtc(e.from);
  const endsAt = toUtc(e.to);
  return {
    dgId: String(e.id),
    url: BASE + e.slug,
    track: e.track?.fullName ?? e.track?.name ?? null,
    // A class event ("Gr.1") has no single car, only carType.
    car: e.car?.fullName ?? e.carType ?? null,
    tyres: e.tyres ?? null,
    settings: (e.settingsChips ?? []).map((c) => c?.label).filter(Boolean),
    startsAt,
    endsAt,
    startDate: startsAt?.slice(0, 10) ?? null,
    endDate: endsAt?.slice(0, 10) ?? null,
    status: e.isActive ? 'live' : e.isEnded ? 'ended' : e.isFuture ? 'upcoming' : 'unknown',
    leadMs: typeof e.leadTime === 'number' ? e.leadTime : null,
    drivers: e.playersCount ?? null,
    trackImage: e.ogImage ?? null,
  };
}

/** The listing: dg-edge's ~12 newest Time Trials, live and recently ended. */
export async function fetchTimeTrials() {
  const { list } = payloadWith(decodeNuxtData(await fetchPage('/events/time-trials')), 'list');
  return list.filter((e) => e?.eventType === 'TT').map(normalizeEvent);
}

/**
 * One Time Trial's page, for what the listing lacks: the world #1's name and
 * the share of drivers holding each medal. Adds { leader, medalShare } to the
 * trial and refreshes the rest from the page.
 */
export async function fetchTimeTrialDetail(trial) {
  const page = payloadWith(decodeNuxtData(await fetchPage(new URL(trial.url).pathname)), 'event');
  const leaderMs = parseTimeToMs(page.leader?.time);
  const fresh = normalizeEvent(page.event);
  return {
    ...trial,
    ...fresh,
    leadMs: fresh.leadMs ?? (Number.isNaN(leaderMs) ? trial.leadMs : leaderMs),
    drivers: page.stats?.total ?? fresh.drivers ?? trial.drivers,
    leader: page.leader?.name ? { name: page.leader.name, timeMs: Number.isNaN(leaderMs) ? null : leaderMs } : null,
    medalShare: page.stats
      ? { gold: page.stats.top03percentPerc ?? null, silver: page.stats.top05percentPerc ?? null, bronze: page.stats.top10percentPerc ?? null }
      : null,
  };
}

/**
 * Whether a dg-edge Time Trial and a site event (GT-GridStats naming) are the
 * same one. The two spell tracks differently -- "SUGO International Racing
 * Course" is GT-GridStats' "Sportsland SUGO", "Brands Hatch - Grand Prix
 * Circuit" its "Brands Hatch Grand Prix Circuit" -- so this is looser than
 * the site's rule 2 (lib/seasons.mjs): both dates exact to a day, plus one
 * distinctive track word in common. Two Time Trials that start together
 * always run at different venues.
 */
export function sameTimeTrial(trial, event) {
  if (!trial.startDate || !event.startDate || daysBetween(trial.startDate, event.startDate) > 1) return false;
  if (trial.endDate && event.endDate && daysBetween(trial.endDate, event.endDate) > 1) return false;
  const words = new Set(trackTokens(trial.track).filter((w) => w.length >= 4));
  return trackTokens(event.track).some((w) => words.has(w));
}
