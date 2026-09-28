#!/usr/bin/env node
/**
 * Track pages (/racing/tracks/): one record per circuit the racing data
 * mentions, with as much public information as Wikipedia carries for it.
 *
 *   npm run scrape:tracks              new circuits only
 *   npm run scrape:tracks -- --full    refetch every circuit
 *
 * Circuit names come from two places: the series files themselves (F1,
 * MotoGP, WSBK, NASCAR carry a circuit per event) and
 * data/racing/track-aliases.json for the series that don't (WEC, IndyCar,
 * Formula E, MotoAmerica). Each name is resolved to a Wikipedia article once
 * (search API, first hit that is a motorsport venue), and circuits that
 * resolve to the same article are the same track -- that is how "Circuit
 * Of The Americas" (MotoGP), "Circuit of the Americas" (WEC alias) and
 * "COTA" (MotoAmerica alias) become one page.
 *
 * What is kept, per track: the article's first paragraph (CC BY-SA, credited
 * on the page), coordinates, and the infobox fields -- length, turns, lap
 * records, location, opened, capacity, surface, layouts -- plus any
 * "elevation change" sentence the article contains. Wikipedia's API terms
 * ask for a descriptive User-Agent and modest rates; both are respected.
 *
 * Wrong matches happen (a street circuit can resolve to its city). Fix one
 * by putting the exact article title in data/racing/track-overrides.json
 * as { "<series>:<circuit name>": "<Wikipedia title>" } and re-running
 * with --full.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getJson, decodeEntities } from './racing/lib/http.mjs';
import { slug } from './racing/lib/schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'racing');
const OUT = path.join(DATA, 'tracks.json');
const API = 'https://en.wikipedia.org/w/api.php';
const DELAY = 700;
const full = process.argv.includes('--full');
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---- gather the circuit names ------------------------------------------

async function circuitNames() {
  const aliases = await readJson(path.join(DATA, 'track-aliases.json'), {});
  const names = new Map(); // "series:name" -> {series, name}
  for (const series of await readdir(DATA, { withFileTypes: true })) {
    if (!series.isDirectory()) continue;
    for (const f of await readdir(path.join(DATA, series.name))) {
      if (!f.endsWith('.json')) continue;
      const file = await readJson(path.join(DATA, series.name, f), null);
      if (!file?.events) continue;
      for (const e of file.events) {
        const name = e.circuit ?? aliases[file.series]?.[e.id] ?? null;
        if (name) names.set(`${file.series}:${name.toLowerCase()}`, { series: file.series, name });
      }
    }
  }
  return [...names.values()];
}

// ---- Wikipedia -----------------------------------------------------------

async function wiki(params) {
  const q = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
  return getJson(`${API}?${q}`, { delayMs: DELAY });
}

async function resolveTitle(name) {
  const tries = [name, `${name} circuit`, `${name} racetrack`];
  for (const term of tries) {
    const res = await wiki({ action: 'query', list: 'search', srsearch: term, srlimit: '5', srnamespace: '0' });
    const hits = res.query?.search ?? [];
    // Prefer a hit whose snippet or title smells like a venue.
    const venue = hits.find((h) => /circuit|raceway|speedway|autodrom|motorsport|race track|racetrack|street circuit|road course|motor park|motorsports park/i.test(`${h.title} ${h.snippet}`));
    if (venue) return venue.title;
    if (hits.length && term === tries[tries.length - 1]) return hits[0].title;
  }
  return null;
}

/** `{{Infobox motorsport venue ...}}` -> { key: value } with wikitext lightly cleaned. */
function parseInfobox(wikitext) {
  // Most circuit articles use {{Motorsport venue ...}}; a few still carry
  // an {{Infobox motorsport venue}} or a plain {{Infobox ...}}.
  const candidates = [/\{\{\s*Motorsport venue\b/i, /\{\{\s*Infobox[^{}|]*venue/i, /\{\{\s*Infobox/i];
  let start = -1;
  for (const re of candidates) {
    start = wikitext.search(re);
    if (start >= 0) break;
  }
  if (start < 0) return {};
  let depth = 0;
  let end = start;
  for (let i = start; i < wikitext.length; i++) {
    if (wikitext.startsWith('{{', i)) depth++, i++;
    else if (wikitext.startsWith('}}', i)) {
      depth--;
      i++;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const body = wikitext.slice(start, end);
  const out = {};
  // Split on top-level "|key =" boundaries.
  let depth2 = 0;
  let cur = '';
  const parts = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (body.startsWith('{{', i) || body.startsWith('[[', i)) depth2++, (cur += body.slice(i, i + 2)), i++;
    else if (body.startsWith('}}', i) || body.startsWith(']]', i)) depth2--, (cur += body.slice(i, i + 2)), i++;
    else if (ch === '|' && depth2 === 1) parts.push(cur), (cur = '');
    else cur += ch;
  }
  parts.push(cur);
  for (const p of parts.slice(1)) {
    const m = p.match(/^\s*([a-z0-9_ ]+?)\s*=\s*([\s\S]*)$/i);
    if (m) out[m[1].trim().toLowerCase()] = cleanWikitext(m[2]);
  }
  return out;
}

function cleanWikitext(s) {
  return decodeEntities(
    String(s ?? '')
      .replace(/<ref[^>]*\/>/g, '')
      .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\{\{start date(?: and age)?\|([^}]*)\}\}/gi, (_, args) => {
        const nums = args.split('|').map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
        return nums.length >= 3 ? `${nums[0]}-${nums[1].padStart(2, '0')}-${nums[2].padStart(2, '0')}` : nums[0] ?? '';
      })
      .replace(/\{\{convert\|([\d.,]+)\|(km|mi|m|ft)[^}]*\}\}/gi, '$1 $2')
      .replace(/\{\{cvt\|([\d.,]+)\|(km|mi|m|ft)[^}]*\}\}/gi, '$1 $2')
      .replace(/\{\{(?:flagicon|flag|flagcountry|flagu|flagdeco)\|[^}]*\}\}/gi, '') // a flag icon adds nothing to "Charles Leclerc"
      .replace(/\{\{nowrap\|([^}]*)\}\}/gi, '$1')
      .replace(/\{\{plainlist\|([\s\S]*?)\}\}/gi, '$1')
      .replace(/\{\{(?:ubl|unbulleted list|hlist)\|([\s\S]*?)\}\}/gi, (_, x) => x.replace(/\|/g, ', '))
      .replace(/\{\{[^{}]*\}\}/g, '')
      .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
      .replace(/'{2,}/g, '')
      .replace(/<br\s*\/?>/gi, ', ')
      .replace(/<[^>]+>/g, '')
      .replace(/\*\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/** The whole sentence around the first match: split on sentence ends that
 * are followed by whitespace, so "5.514 km" and "St. Petersburg" don't cut
 * it short. */
function sentenceWith(text, re) {
  const i = text.search(re);
  if (i < 0) return null;
  const before = text.slice(0, i);
  const after = text.slice(i);
  const startMatch = before.match(/[.!?](?=\s+[A-Z(])[^.!?]*$/);
  const start = startMatch ? startMatch.index + 1 : Math.max(0, before.lastIndexOf('\n'));
  const endMatch = after.match(/[.!?](?=\s+[A-Z(]|\s*$|\n)/);
  const end = endMatch ? i + endMatch.index + 1 : text.length;
  return text.slice(start, end).replace(/\s+/g, ' ').trim() || null;
}

function num(s) {
  const m = String(s ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Lap records: the infobox has either one record_* set or per-layout
 * sections with record_time/driver/team/year/class suffixed by nothing or
 * a number (record_time2 ...). */
function records(box) {
  const out = [];
  const keys = Object.keys(box).filter((k) => /^record_time\d*$/.test(k));
  for (const k of keys) {
    const n = k.replace('record_time', '');
    const rec = {
      cls: box[`record_class${n}`] ?? null,
      time: box[k] ?? null,
      driver: box[`record_driver${n}`] ?? null,
      team: box[`record_team${n}`] ?? null,
      year: box[`record_year${n}`] ?? null,
    };
    if (rec.time) out.push(rec);
  }
  return out;
}

async function fetchTrack(title) {
  const page = await wiki({
    action: 'query',
    prop: 'extracts|coordinates|revisions|pageprops',
    titles: title,
    exintro: '1',
    explaintext: '1',
    rvprop: 'content',
    rvslots: 'main',
    redirects: '1',
  });
  const p = page.query?.pages?.[0];
  if (!p || p.missing) return null;
  const wikitext = p.revisions?.[0]?.slots?.main?.content ?? '';
  const box = parseInfobox(wikitext);
  // "elevation change" is prose, not infobox: grab the sentence when there is one.
  const fullText = (await wiki({ action: 'query', prop: 'extracts', titles: p.title, explaintext: '1', redirects: '1' })).query?.pages?.[0]?.extract ?? '';
  const elevation = sentenceWith(fullText, /\b(?:elevation (?:change|difference|gain)|change in elevation)\b/i);
  const lengthKm = num(box.length_km) ?? (box.length_mi ? Number((num(box.length_mi) * 1.609344).toFixed(3)) : null) ?? (box.length ? num(box.length) : null);
  const lengthMi = num(box.length_mi) ?? (lengthKm ? Number((lengthKm / 1.609344).toFixed(3)) : null);
  return {
    wikiTitle: p.title,
    wikiUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
    summary: (p.extract ?? '').split(/\n\n/)[0]?.trim() || null,
    location: box.location ?? null,
    country: box.country ?? null,
    coordinates: p.coordinates?.[0] ? { lat: p.coordinates[0].lat, lon: p.coordinates[0].lon } : null,
    lengthKm,
    lengthMi,
    turns: num(box.turns),
    opened: box.opened ?? null,
    capacity: box.capacity ?? null,
    surface: box.surface ?? null,
    elevation,
    layouts: box.layout ?? box.layouts ?? null,
    records: records(box),
  };
}

// ---- main ----------------------------------------------------------------

const names = await circuitNames();
const overrides = await readJson(path.join(DATA, 'track-overrides.json'), {});
// --full starts from nothing, so a circuit that used to resolve to the wrong
// article (before an override) doesn't linger as a stray track.
const previous = full ? { tracks: [] } : await readJson(OUT, { tracks: [] });
const byTitle = new Map(); // wikiTitle -> track
for (const t of previous.tracks ?? []) byTitle.set(t.wikiTitle, t);
const knownAlias = new Map();
for (const t of previous.tracks ?? []) for (const a of t.aliases) knownAlias.set(`${a.series}:${a.name.toLowerCase()}`, t.wikiTitle);

log(`${names.length} circuit names across the series files`);
let fetched = 0;
for (const { series, name } of names) {
  const key = `${series}:${name.toLowerCase()}`;
  let title = overrides[`${series}:${name}`] ?? overrides[name] ?? (full ? null : knownAlias.get(key)) ?? null;
  if (!title) {
    title = await resolveTitle(name);
    if (!title) {
      console.warn(`WARN: no Wikipedia article found for "${name}" (${series})`);
      continue;
    }
  }
  let track = byTitle.get(title);
  if (!track || full) {
    log(`  ${name} -> ${title}`);
    const info = await fetchTrack(title);
    if (!info) {
      console.warn(`WARN: article "${title}" missing for "${name}"`);
      continue;
    }
    fetched++;
    // A redirect can land on a title already on file.
    track = byTitle.get(info.wikiTitle) ?? { slug: slug(info.wikiTitle), name: info.wikiTitle, aliases: [] };
    Object.assign(track, info, { name: info.wikiTitle.replace(/ \(.*\)$/, ''), fetchedAt: new Date().toISOString() });
    byTitle.set(track.wikiTitle, track);
    if (title !== track.wikiTitle) byTitle.set(title, track);
  }
  if (!track.aliases.some((a) => a.series === series && a.name.toLowerCase() === name.toLowerCase())) track.aliases.push({ series, name });
}

const tracks = [...new Set(byTitle.values())].sort((a, b) => a.name.localeCompare(b.name));
await writeFile(OUT, JSON.stringify({ syncedAt: new Date().toISOString(), tracks }, null, 2) + '\n');
log(`wrote ${tracks.length} tracks (${fetched} fetched)`);
