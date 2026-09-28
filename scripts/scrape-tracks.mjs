#!/usr/bin/env node
/**
 * Track pages (/racing/tracks/): one record per circuit the racing data
 * mentions, with the public facts Wikipedia carries for it and a drawn
 * layout of the circuit.
 *
 *   npm run scrape:tracks              new circuits only
 *   npm run scrape:tracks -- --full    refetch every circuit (after an override)
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
 * Facts, per track: coordinates and the infobox fields -- length, turns,
 * location, opened, capacity, surface, layouts -- plus any "elevation
 * change" sentence the article contains (that figure is only ever prose).
 *
 * Layout, per track, one of:
 *   - the article's SVG track map from Wikimedia Commons (most circuits;
 *     these are the drawn maps with numbered turns), downloaded once to
 *     public/tracks/<slug>.svg with scripts stripped, licence and author
 *     recorded for the page's credit line;
 *   - otherwise an outline drawn here from OpenStreetMap's raceway ways
 *     around the circuit's coordinates (street circuits mostly; no turn
 *     numbers, the page says so);
 *   - otherwise nothing.
 * Raster maps (PNG/JPG) are deliberately not used: the site is drawn.
 *
 * Wikipedia's and Overpass's API terms ask for a descriptive User-Agent and
 * modest rates; both are respected. Wrong matches happen (a street circuit
 * can resolve to its city). Fix one by putting the exact article title in
 * data/racing/track-overrides.json as { "<series>:<circuit name>":
 * "<Wikipedia title>" } and re-running with --full. A wrong or unwanted map
 * is overridden the same way with { "layout:<slug>": "<File name.svg>" } or
 * { "layout:<slug>": "osm" }.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getJson, getText, request, decodeEntities } from './racing/lib/http.mjs';
import { slug } from './racing/lib/schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'racing');
const OUT = path.join(DATA, 'tracks.json');
const SVG_DIR = path.join(__dirname, '..', 'public', 'tracks');
const API = 'https://en.wikipedia.org/w/api.php';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const DELAY = 700;
const full = process.argv.includes('--full');
// --relayout: only retry the drawing for tracks that have none (no Wikipedia refetch).
const relayout = process.argv.includes('--relayout');
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

async function wiki(params, base = API) {
  const q = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
  return getJson(`${base}?${q}`, { delayMs: DELAY });
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

/** `{{Motorsport venue ...}}` (or an Infobox) -> { key: value }, wikitext lightly cleaned. */
function parseInfobox(wikitext) {
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
    if (m) out[m[1].trim().toLowerCase()] = m[2].trim();
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
      .replace(/\{\{(?:flagicon|flag|flagcountry|flagu|flagdeco)\|[^}]*\}\}/gi, '')
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

/** The infobox image's file name, if it is an SVG. */
function infoboxSvg(box) {
  const raw = String(box.image ?? '')
    .replace(/^\[\[(?:image|file):/i, '')
    .replace(/^file:/i, '')
    .split(/\||\{\{!\}\}|\]\]/)[0]
    .trim();
  return /\.svg$/i.test(raw) ? raw : null;
}

const MAP_WORDS = /map|layout|circuit|track|course|speedway|raceway|ring|strecke|autodrom|configuration/i;
const NOT_MAP = /logo|flag|icon|wiki|symbol|commons|crystal|pictogram|nuvola|edit|question|ambox|padlock|star|check|sound|speaker|arrow|locator|location map|rallycross|kart|historic|19\d\d|200\d/i;

/** Best SVG map among the article's images: prefers "track map"/"layout"
 * names, then the newest year in the name. */
function pickSvg(images, box) {
  const fromBox = infoboxSvg(box);
  if (fromBox) return fromBox;
  const cands = images
    .map((t) => t.replace(/^File:/, ''))
    .filter((n) => /\.svg$/i.test(n) && MAP_WORDS.test(n) && !NOT_MAP.test(n));
  if (!cands.length) return null;
  const score = (n) => (/track map|layout|circuit/i.test(n) ? 10 : 0) + (Number(n.match(/20\d\d/)?.[0] ?? 0) % 100) / 100 - (/road course|alternate|inverted|2nd|oval only/i.test(n) ? 5 : 0);
  return cands.sort((a, b) => score(b) - score(a))[0];
}

async function fetchTrack(title) {
  const page = await wiki({
    action: 'query',
    prop: 'extracts|coordinates|revisions|images',
    titles: title,
    explaintext: '1',
    rvprop: 'content',
    rvslots: 'main',
    imlimit: '100',
    redirects: '1',
  });
  const p = page.query?.pages?.[0];
  if (!p || p.missing) return null;
  const wikitext = p.revisions?.[0]?.slots?.main?.content ?? '';
  const rawBox = parseInfobox(wikitext);
  const box = Object.fromEntries(Object.entries(rawBox).map(([k, v]) => [k, cleanWikitext(v)]));
  const fullText = p.extract ?? '';
  const elevation = sentenceWith(fullText, /\b(?:elevation (?:change|difference|gain)|change in elevation)\b/i);
  const lengthKm = num(box.length_km) ?? (box.length_mi ? Number((num(box.length_mi) * 1.609344).toFixed(3)) : null) ?? (box.length ? num(box.length) : null);
  const lengthMi = num(box.length_mi) ?? (lengthKm ? Number((lengthKm / 1.609344).toFixed(3)) : null);
  return {
    wikiTitle: p.title,
    wikiUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
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
    svgCandidate: pickSvg((p.images ?? []).map((i) => i.title), rawBox),
  };
}

// ---- layouts -------------------------------------------------------------

/** Scripts and handlers out; a viewBox in; width/height off the root so CSS sizes it. */
function sanitizeSvg(svg) {
  let s = svg
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<!DOCTYPE[^>]*>/i, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/(xlink:href|href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '')
    .trim();
  const root = s.match(/<svg[^>]*>/i)?.[0];
  if (!root) return null;
  let newRoot = root;
  if (!/viewBox=/i.test(root)) {
    const w = root.match(/\swidth\s*=\s*"([\d.]+)/i)?.[1];
    const h = root.match(/\sheight\s*=\s*"([\d.]+)/i)?.[1];
    if (w && h) newRoot = newRoot.replace(/<svg/i, `<svg viewBox="0 0 ${w} ${h}"`);
  }
  newRoot = newRoot.replace(/\s(width|height)\s*=\s*"[^"]*"/gi, '');
  if (!/xmlns=/.test(newRoot)) newRoot = newRoot.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return s.replace(root, newRoot);
}

async function commonsLayout(fileName) {
  const info = await wiki({ action: 'query', prop: 'imageinfo', titles: `File:${fileName}`, iiprop: 'url|extmetadata' }, COMMONS);
  const ii = info.query?.pages?.[0]?.imageinfo?.[0];
  if (!ii?.url) return null;
  const m = ii.extmetadata ?? {};
  const text = (v) => decodeEntities(String(v?.value ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() || null;
  // The Artist field often has the upload boilerplate glued on ("Own work
  // This W3C-unspecified vector image was created with Inkscape"): keep the name.
  const artist = (text(m.Artist) ?? '').split(/Own work|This W3C|This vector|derivative work|\bby\b|,/i)[0].trim() || null;
  const svg = sanitizeSvg(await getText(ii.url, { delayMs: DELAY }));
  if (!svg) return null;
  return {
    svg,
    layout: {
      kind: 'wikimedia',
      file: fileName,
      url: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName.replace(/ /g, '_'))}`,
      license: text(m.LicenseShortName),
      licenseUrl: text(m.LicenseUrl),
      artist,
      // Best guess at "has numbered turns": digits in text, or the file
      // name says so. Maps with outlined glyphs can't be told apart.
      numbered: /\d+\s*turns/i.test(fileName) || (svg.match(/<text[^>]*>[^<]*\d/g) ?? []).length >= 4 ? true : null,
    },
  };
}

/** An outline of the circuit from OpenStreetMap's raceway ways near its
 * coordinates, drawn as our own SVG in the site's colours. */
async function osmLayout(coords) {
  if (!coords) return null;
  const q = `[out:json][timeout:25];way["highway"="raceway"](around:2200,${coords.lat},${coords.lon});out geom;`;
  let res;
  try {
    res = await request(OVERPASS, {
      method: 'POST',
      body: `data=${encodeURIComponent(q)}`,
      // Overpass answers 406 to a "Mozilla/5.0 (compatible; ...)" agent; it
      // wants a plain tool name.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'GoonTurismoBot/1.0 (+https://goon-turismo.com)' },
      delayMs: 1500,
    });
  } catch (err) {
    console.warn(`WARN: Overpass: ${err.message}`);
    return null;
  }
  const json = await res.json();
  const ways = (json.elements ?? []).filter((w) => w.geometry?.length > 1 && !/kart/i.test(`${w.tags?.name ?? ''} ${w.tags?.sport ?? ''}`));
  if (!ways.length) return null;
  const k = Math.cos((coords.lat * Math.PI) / 180);
  const pts = ways.flatMap((w) => w.geometry.map((g) => [g.lon * k, -g.lat]));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const W = 800;
  const H = 560;
  const pad = 40;
  const scale = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
  const ox = (W - (maxX - minX) * scale) / 2;
  const oy = (H - (maxY - minY) * scale) / 2;
  const tx = (x) => (ox + (x - minX) * scale).toFixed(1);
  const ty = (y) => (oy + (y - minY) * scale).toFixed(1);
  const paths = ways
    .map((w) => `<path d="M${w.geometry.map((g) => `${tx(g.lon * k)} ${ty(-g.lat)}`).join(' L')}" />`)
    .join('\n    ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Circuit outline from OpenStreetMap">
  <g fill="none" stroke="#ff3b2e" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity=".35">
    ${paths}
  </g>
  <g fill="none" stroke="#ffd23f" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    ${paths}
  </g>
</svg>
`;
  return { svg, layout: { kind: 'osm', file: null, url: `https://www.openstreetmap.org/#map=15/${coords.lat}/${coords.lon}`, license: 'ODbL', licenseUrl: 'https://www.openstreetmap.org/copyright', artist: 'OpenStreetMap contributors', numbered: false } };
}

async function layoutFor(track, overrides) {
  const forced = overrides[`layout:${track.slug}`];
  const wanted = forced && forced !== 'osm' ? forced : forced === 'osm' ? null : track.svgCandidate;
  let got = null;
  if (wanted) {
    try {
      got = await commonsLayout(wanted);
    } catch (err) {
      console.warn(`WARN: layout "${wanted}" for ${track.name}: ${err.message}`);
    }
  }
  if (!got) got = await osmLayout(track.coordinates);
  if (!got) return null;
  await mkdir(SVG_DIR, { recursive: true });
  await writeFile(path.join(SVG_DIR, `${track.slug}.svg`), got.svg);
  return { ...got.layout, path: `/tracks/${track.slug}.svg` };
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

if (relayout) {
  let redone = 0;
  for (const t of previous.tracks ?? []) {
    if (t.layout) continue;
    log(`  relayout ${t.name}`);
    t.layout = await layoutFor({ ...t, svgCandidate: overrides[`layout:${t.slug}`] ?? null }, overrides);
    if (t.layout) redone++;
  }
  await writeFile(OUT, JSON.stringify({ syncedAt: new Date().toISOString(), tracks: previous.tracks }, null, 2) + '\n');
  log(`relayout: ${redone} tracks gained a drawing`);
  process.exit(0);
}

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
    const { svgCandidate, ...facts } = info;
    Object.assign(track, facts, { name: info.wikiTitle.replace(/ \(.*\)$/, ''), fetchedAt: new Date().toISOString() });
    delete track.summary;
    delete track.records;
    track.layout = await layoutFor({ ...track, svgCandidate }, overrides);
    byTitle.set(track.wikiTitle, track);
    if (title !== track.wikiTitle) byTitle.set(title, track);
  }
  if (!track.aliases.some((a) => a.series === series && a.name.toLowerCase() === name.toLowerCase())) track.aliases.push({ series, name });
}

const tracks = [...new Set(byTitle.values())].sort((a, b) => a.name.localeCompare(b.name));
await writeFile(OUT, JSON.stringify({ syncedAt: new Date().toISOString(), tracks }, null, 2) + '\n');
const withMap = tracks.filter((t) => t.layout).length;
const numbered = tracks.filter((t) => t.layout?.kind === 'wikimedia').length;
log(`wrote ${tracks.length} tracks (${fetched} fetched; ${withMap} with a layout, ${numbered} from Wikimedia maps)`);
