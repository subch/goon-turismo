/**
 * The bot's Goon TT replies: the board for /goontt, and the answer to a
 * submitted lap. Built here, beside the data, so bot.mjs (in subch-vps) only
 * posts what it is handed.
 */
import { md, discordTime } from '../discord/format.mjs';
import { board, gapText, status, TYRE_NAMES } from './standings.mjs';

const SITE = 'https://goon-turismo.com';
// The site's cyan neon (src/styles/global.css), apart from the official
// Time Trial posts' red, orange and yellow.
const COLOR = 0x35e0ff;

export const ttUrl = (tt) => `${SITE}/goon-tt/${tt.id}/`;

const payload = (content, embeds = []) => ({ content, embeds, allowed_mentions: { parse: [] } });

/** "1. **dog_nougat** 1:27.864 · 100 pts", then the gap for everyone behind. */
function boardLines(rows, name) {
  return rows
    .map((r) => `${r.place}. **${md(name(r.psn))}** ${r.time}${r.gapMs ? ` · ${gapText(r.gapMs)}` : ''} · ${r.points} pts`)
    .join('\n');
}

function boardEmbed(tt, rows, name, now) {
  const state = status(tt, now);
  const conditions = [tt.timeOfDay, tt.penalties && `${tt.penalties.toLowerCase()} penalties`].filter(Boolean).join(', ');
  const when =
    state === 'running'
      ? `Closes ${discordTime(tt.closesAt, 'f')} (${discordTime(tt.closesAt, 'R')})`
      : state === 'upcoming'
        ? `Opens ${discordTime(tt.opensAt, 'f')} (${discordTime(tt.opensAt, 'R')})`
        : `Closed ${discordTime(tt.closesAt, 'D')}`;
  const description = [
    `${md(tt.car)} · ${TYRE_NAMES[tt.tyres] ?? tt.tyres} · PP ${tt.pp.toFixed(2)}`,
    [conditions, tt.tuneId ? `[the tune](${SITE}/tunes/${tt.tuneId}/)` : null].filter(Boolean).join(' · '),
    when,
    '',
    rows.length ? boardLines(rows, name) : '_No laps yet._',
  ];
  return { title: `${tt.name}: ${tt.track}`, url: ttUrl(tt), color: COLOR, description: description.join('\n') };
}

/** /goontt: the running Goon TT's board, or the latest one's when none is running. */
export function boardMessage(tt, { name, now = new Date(), points } = {}) {
  if (!tt) return payload('No Goon TT on file yet.');
  const state = status(tt, now);
  const heading = state === 'closed' ? '🏁 **Goon TT final board**' : state === 'upcoming' ? '🗓️ **Next Goon TT**' : '⏱️ **Goon TT board**';
  return payload(heading, [boardEmbed(tt, board(tt, points), name, now)]);
}

/** A lap that passed: where it puts the driver, and the board with it on. `tt` already holds the lap. */
export function acceptedMessage(tt, psn, lap, { name, now = new Date(), points } = {}) {
  const rows = board(tt, points);
  const mine = rows.find((r) => r.psn === psn);
  const who = `**${md(name(psn))}**`;
  const line =
    mine.lap === lap || mine.timeMs === lap.timeMs
      ? `✅ ${who} ${mine.time}: P${mine.place} of ${rows.length}, ${mine.gapMs ? `${gapText(mine.gapMs)} off the lead` : 'fastest so far'}, ${mine.points} pts`
      : `✅ ${who} ${lap.time} is in; their best stays ${mine.time} (P${mine.place})`;
  return payload(`${line}\nScreenshot checked and kept as proof. On the site in a few minutes.`, [boardEmbed(tt, rows, name, now)]);
}

/** A lap that didn't: every reason, so the driver knows what to fix. */
export function refusedMessage(psn, reasons, { name } = {}) {
  const who = psn ? `**${md(name ? name(psn) : psn)}**'s lap` : 'that lap';
  return payload(`❌ Couldn't take ${who}: ${reasons.join('; ')}.`);
}
