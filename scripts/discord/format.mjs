// The Discord messages themselves, as channel-message payloads. Pure
// functions only: scripts/post-discord.mjs decides what is due, fetches what
// these need and sends them; scripts/discord/plan.mjs holds the "what is due"
// rules.
//
// Discord limits that shape this: 10 embeds and 6000 characters per message,
// 4096 per embed description, 1024 per field. A Time Trial's crew list is
// well inside that (24 players on file); the crew lists in the daily posts
// are capped anyway. <t:…> timestamps render in each reader's own timezone,
// but only in descriptions and fields, never in titles or footers.
//
// One driver, one line, on a phone too (crew feedback, 2026-10-22). A phone
// fits about 43 characters across an embed, so every driver line is kept
// under ~40 even for the longest name on the roster (16), and no embed with
// a crew list carries a thumbnail: it takes a column down the right-hand side
// and narrows every line of text. The track photo goes underneath instead.

const SITE = 'https://goon-turismo.com';

// The site's colourway (src/styles/global.css: --a, --c, --b).
const COLOR = { results: 0xff3b2e, newTrial: 0xff8a1f, leader: 0xffd23f };

/**
 * GT7's Time Trial reward tiers: a lap within 3% of the world #1 earns gold,
 * 5% silver, 10% bronze (GTPlanet's weekly Time Trial write-ups, checked
 * 2026-10-21). The cut-offs move with the leaderboard until the event closes
 * -- a lap that was gold when it was set can finish silver -- which is what
 * the daily world #1 post is for. dg-edge shows the same cut-offs, rounded up
 * to the thousandth (gold 1:19.141 off a 1:16.835), and so does this. Its
 * extra "Platinum +0.5%" is dg-edge's own; GT7 pays nothing for it. Some
 * events have run a wider bronze tier; nobody publishes that, so it isn't
 * modelled.
 */
export const TIERS = [
  { key: 'gold', label: 'Gold', icon: '🟡', pct: 3 },
  { key: 'silver', label: 'Silver', icon: '⚪', pct: 5 },
  { key: 'bronze', label: 'Bronze', icon: '🟤', pct: 10 },
];

const PODIUM = ['🥇', '🥈', '🥉'];

// GT7's tyre codes, as dg-edge gives them.
const TYRES = {
  CH: 'Comfort Hard', CM: 'Comfort Medium', CS: 'Comfort Soft',
  SH: 'Sports Hard', SM: 'Sports Medium', SS: 'Sports Soft',
  RH: 'Racing Hard', RM: 'Racing Medium', RS: 'Racing Soft',
  IM: 'Intermediate', HW: 'Heavy Wet', DT: 'Dirt', SN: 'Snow',
};

/** Slowest lap that still earns `tier` against a world #1 of `topMs`. */
export function cutoffMs(topMs, tier) {
  // Integer percent maths: 76835 * 1.03 in floating point is 79140.05000000002.
  return Math.ceil((topMs * (100 + tier.pct)) / 100);
}

/** The GT7 tier a lap earns against a world #1 of `topMs`, or null. */
export function tierFor(timeMs, topMs) {
  if (timeMs == null || topMs == null) return null;
  return TIERS.find((t) => timeMs <= cutoffMs(topMs, t)) ?? null;
}

/** 76835 -> "1:16.835", 59123 -> "59.123" (GT7 shows thousandths). */
export function formatMs(ms) {
  const total = Math.round(Math.abs(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = ((total % 60000) / 1000).toFixed(3);
  return minutes > 0 ? `${minutes}:${seconds.padStart(6, '0')}` : seconds;
}

/** Signed difference: "+1.290", "−0.065". */
export function formatDelta(ms) {
  return `${ms < 0 ? '−' : '+'}${formatMs(ms)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-22" -> "22 Oct 2026", the one date format the site uses. */
export function formatDate(iso) {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${parseInt(m[3], 10)} ${MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}` : null;
}

export function formatRange(startIso, endIso) {
  const start = formatDate(startIso);
  const end = formatDate(endIso);
  if (start && end && start !== end) return `${start} – ${end}`;
  return start || end || 'Dates TBD';
}

/** Discord's <t:…> markup: f = "29 October 2026 07:59", R = "in 7 days". */
export function discordTime(iso, style) {
  return `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;
}

/**
 * Escape Discord markdown in a name. PSN ids are full of underscores, and
 * "empire_of_ravens" would otherwise render as "empire*of*ravens".
 */
export function md(text) {
  return String(text ?? '').replace(/[\\*_~`|>[\]]/g, '\\$&');
}

// The same guess as wikiUrl in src/lib/data.ts, which Astro compiles and
// plain Node cannot import. Keep the two in step.
const WIKI_BASE = 'https://gran-turismo.fandom.com/wiki/';
const GENERIC_CLASS_RE = /^(gr\.?|group)\s*\d/i;

export function wikiUrl(name) {
  const cleaned = String(name ?? '')
    .replace(/\s*\([A-Z]{2,3}\)\s*$/, '')
    .trim();
  if (!cleaned || GENERIC_CLASS_RE.test(cleaned)) return null;
  return WIKI_BASE + encodeURIComponent(cleaned.replace(/ /g, '_'));
}

export function eventUrl(eventId) {
  return eventId ? `${SITE}/events/${eventId}/` : `${SITE}/`;
}

function payload(content, embeds) {
  // Names come from PSN ids and dg-edge; never let one ping anybody.
  return { content, embeds, allowed_mentions: { parse: [] } };
}

function tierTargets(topMs) {
  return TIERS.map((t) => `${t.icon} ${t.label} ≤ ${formatMs(cutoffMs(topMs, t))}`).join('\n');
}

function byWhom(name) {
  return name ? ` by ${md(name)}` : '';
}

function raceSettings(trial) {
  const tyres = trial.tyres ? `${TYRES[trial.tyres] ?? trial.tyres} (${trial.tyres})` : null;
  return [tyres, ...(trial.settings ?? [])].filter(Boolean).join(' · ');
}

/**
 * The crew's laps on a running Time Trial against today's world #1, as an
 * embed field: one line per driver -- tier, name, lap, and in brackets how
 * far off gold anyone outside it is. `previousTopMs` marks with ↓ a lap the
 * moving cut-off has just pushed down a tier. The field name explains both
 * marks, so the lines don't have to.
 */
function crewField(title, rows, name, topMs, previousTopMs = null, limit = 10) {
  const gold = cutoffMs(topMs, TIERS[0]);
  let dropped = false;
  const lines = rows.slice(0, limit).map((r) => {
    const tier = tierFor(r.timeMs, topMs);
    let line = `${tier?.icon ?? '▫️'} **${md(name(r.psn))}** ${formatMs(r.timeMs)}`;
    if (tier?.key !== 'gold') line += ` (${formatDelta(r.timeMs - gold)})`;
    const before = previousTopMs != null ? tierFor(r.timeMs, previousTopMs) : null;
    if (before && TIERS.indexOf(before) < (tier ? TIERS.indexOf(tier) : TIERS.length)) {
      line += ' ↓';
      dropped = true;
    }
    return line;
  });
  if (rows.length > limit) lines.push(`…and ${rows.length - limit} more on the site`);
  return { name: `${title} · (gap to gold)${dropped ? ' · ↓ dropped a tier' : ''}`, value: lines.join('\n') };
}

/**
 * Final results for a Time Trial that has closed.
 *   event   data/official-events record
 *   rows    its data/results/official.json rows
 *   final   the closed dg-edge trial (leadMs, leader, url, trackImage), whose
 *           final world #1 the medals are judged against; null leaves them out
 */
export function resultsMessage({ event, rows, name, seasonName, final }) {
  const timed = rows.filter((r) => r.timeMs != null).sort((a, b) => a.timeMs - b.timeMs);
  const topMs = final?.leadMs ?? null;

  // No gap to the winner: the points already say it (−10 per 1% off).
  const lines = timed.map((r, i) => {
    // "4." at the start of a line is a Markdown list item; escape the dot.
    const place = PODIUM[i] ?? `${i + 1}\\.`;
    const tier = tierFor(r.timeMs, topMs);
    return `${place} **${md(name(r.psn))}** ${formatMs(r.timeMs)} · ${r.points} pts${tier ? ` ${tier.icon}` : ''}`;
  });

  const description = [`**${md(event.car ?? 'Car TBD')}**`, formatRange(event.startDate, event.endDate), ''];
  description.push(lines.length ? lines.join('\n') : '_No crew times on file for this one._');

  const fields = [];
  if (topMs != null && timed.length) {
    const counts = TIERS.map((t) => [t, timed.filter((r) => tierFor(r.timeMs, topMs) === t).length])
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${t.icon}×${n}`);
    const value = [`Final world #1 **${formatMs(topMs)}**${byWhom(final.leader?.name)}`, tierTargets(topMs)];
    if (final.url) value.push(`[Final leaderboard on dg-edge](${final.url})`);
    fields.push({ name: `GT7 medals${counts.length ? `: ${counts.join(' ')}` : ': none'}`, value: value.join('\n') });
  }

  return payload('🏁 **Time Trial results are in**', [
    {
      title: event.track ?? 'Time Trial',
      url: eventUrl(event.id),
      color: COLOR.results,
      description: description.join('\n'),
      fields,
      ...(final?.trackImage ? { image: { url: final.trackImage } } : {}),
      footer: { text: `${seasonName ? `${seasonName} · ` : ''}Fastest crew lap scores 100, −10 per 1% off the pace` },
    },
  ]);
}

/**
 * A Time Trial that has just gone live.
 *   trial    dg-edge trial with its detail (leader, medalShare)
 *   eventId  the matching site event, once the sync has seen a crew lap
 *   crew     the crew's laps so far (data/results rows), often none yet
 */
export function newTrialMessage({ trial, eventId, crew, name }) {
  const description = [`**${md(trial.car ?? 'Car TBD')}**`];
  const settings = raceSettings(trial);
  if (settings) description.push(settings);
  if (trial.startsAt) description.push(`Opened ${discordTime(trial.startsAt, 'f')}`);
  if (trial.endsAt) description.push(`Closes ${discordTime(trial.endsAt, 'f')} (${discordTime(trial.endsAt, 'R')})`);
  const links = [`[Full details on dg-edge](${trial.url})`, wikiUrl(trial.car) && `[Car](${wikiUrl(trial.car)})`];
  description.push(links.filter(Boolean).join(' · '));

  const topMs = trial.leadMs;
  const fields = [
    { name: 'World #1', value: topMs != null ? `**${formatMs(topMs)}**${byWhom(trial.leader?.name)}` : 'No laps posted yet', inline: true },
  ];
  if (topMs != null) fields.push({ name: 'GT7 medal targets', value: tierTargets(topMs), inline: true });
  if (trial.drivers) {
    const gold = trial.medalShare?.gold;
    fields.push({
      name: 'Drivers',
      value: `${trial.drivers.toLocaleString('en-US')}${gold != null ? `\n${gold}% in gold` : ''}`,
      inline: true,
    });
  }
  if (topMs != null && crew.length) fields.push(crewField('Crew so far', crew, name, topMs));

  return payload('🆕 **A new Time Trial is live**', [
    {
      title: trial.track,
      url: eventId ? eventUrl(eventId) : trial.url,
      color: COLOR.newTrial,
      description: description.join('\n'),
      fields,
      ...(trial.trackImage ? { image: { url: trial.trackImage } } : {}),
      footer: { text: 'The medal targets move whenever the world #1 drops. Checked daily at noon Central.' },
    },
  ]);
}

/**
 * The world #1 on one or more running Time Trials changed since yesterday.
 *   changes  [{ trial, previous: { name, timeMs }, eventId, crew }]
 */
export function leaderChangeMessage({ changes, name }) {
  const embeds = changes.map(({ trial, previous, eventId, crew }) => {
    const topMs = trial.leadMs;
    const goldNow = cutoffMs(topMs, TIERS[0]);
    const goldBefore = cutoffMs(previous.timeMs, TIERS[0]);
    const description = [
      `World #1 **${formatMs(topMs)}**${byWhom(trial.leader?.name)}`,
      `was ${formatMs(previous.timeMs)}${byWhom(previous.name)} (${formatDelta(topMs - previous.timeMs)})`,
      '',
      `${TIERS[0].icon} Gold is now ≤ **${formatMs(goldNow)}** (was ${formatMs(goldBefore)})`,
      TIERS.slice(1)
        .map((t) => `${t.icon} ${t.label} ≤ ${formatMs(cutoffMs(topMs, t))}`)
        .join(' · '),
    ];
    if (trial.endsAt) description.push('', `Closes ${discordTime(trial.endsAt, 'f')} (${discordTime(trial.endsAt, 'R')})`);
    // Discord rejects a footer with empty text.
    const footer = [trial.car, raceSettings(trial)].filter(Boolean).join(' · ');
    return {
      title: trial.track,
      url: eventId ? eventUrl(eventId) : trial.url,
      color: COLOR.leader,
      description: description.join('\n'),
      fields: crew.length ? [crewField('Crew right now', crew, name, topMs, previous.timeMs)] : [],
      ...(footer ? { footer: { text: footer } } : {}),
    };
  });
  return payload('⏱️ **The world #1 moved, so the GT7 medal targets did too**', embeds);
}
