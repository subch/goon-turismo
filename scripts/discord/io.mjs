// The poster's two side effects: sending as the bot, and the small
// per-channel state file that remembers what has been sent.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { emptyState } from './plan.mjs';

const API = 'https://discord.com/api/v10';
// Discord wants bot API calls to say what they are, in this exact shape.
const USER_AGENT = 'DiscordBot (https://goon-turismo.com, 1.0)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The same guard sync.sh has for the GT-GridStats token: a value that is
// obviously not a bot token (the application id, the public key, a webhook
// URL) is treated as unset rather than sent anywhere. A token is three
// dot-separated base64url parts.
export function isBotToken(token) {
  return /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(String(token ?? '').trim());
}

/** Discord ids (channels, guilds, applications) are 17-20 digit snowflakes. */
export function isSnowflake(id) {
  return /^\d{17,20}$/.test(String(id ?? '').trim());
}

// What the usual refusals mean here, so the log says what to fix.
const HINTS = {
  401: 'the bot token is wrong or was reset -- copy a fresh one from the Developer Portal (Bot > Reset Token)',
  10003: 'no channel with that id -- check GOON_DISCORD_CHANNEL_ID',
  50001: 'the bot cannot see that channel -- is it in that server, and does it have View Channel there?',
  50013: 'the bot lacks a permission in that channel -- it needs View Channel, Send Messages and Embed Links',
};

/**
 * Send one message to a channel as the bot. Rate limits (429) are waited out
 * and retried a few times; anything else throws. The token is a credential,
 * so it never appears in an error.
 */
export async function postMessage(token, channelId, payload) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/channels/${channelId.trim()}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token.trim()}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {}
    if (res.status === 429 && attempt < 4) {
      await sleep(Math.ceil((body.retry_after ?? 2) * 1000) + 250);
      continue;
    }
    const hint = HINTS[body.code] ?? HINTS[res.status];
    throw new Error(`Discord answered ${res.status}: ${text.slice(0, 300)}${hint ? ` -- ${hint}` : ''}`);
  }
}

/** One state file per channel, so moving to a new channel starts it afresh. */
export function statePath(dir, channelId) {
  return path.join(dir, `${channelId}.json`);
}

/**
 * A missing file is a first run. A file that exists but does not parse is an
 * error, not a fresh start: starting over would re-post the last few days.
 */
export async function loadState(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
  return { ...emptyState(), ...JSON.parse(raw) };
}

/** Written to a temp file and renamed over, so a crash never leaves half a file. */
export async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
  await rename(tmp, file);
}
