#!/usr/bin/env node
/**
 * Setting up the Goon Turismo bot: logs it in once, then lists every server
 * it has been invited to and the text channels in each, with their ids --
 * the id to put in GOON_DISCORD_CHANNEL_ID. Also prints the invite link.
 *
 * The one gateway login is not just a check: Discord will not let a bot post
 * through the API until it has connected to the gateway at least once.
 * post-discord.mjs never connects, so run this once per new bot token.
 *
 *   npm run discord:check
 *
 * Needs Node 22+ (the built-in WebSocket) -- run it on the workstation, not
 * in goon-scraper (Node 20). Reads GOON_DISCORD_BOT_TOKEN and, if set,
 * GOON_DISCORD_CHANNEL_ID from the environment or a .env in the repo root.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isBotToken } from './discord/io.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const INTENT_GUILDS = 1 << 0; // server and channel lists; not a privileged intent
// View Channel + Send Messages + Embed Links: all the posts need.
const PERMISSIONS = (1 << 10) | (1 << 11) | (1 << 14);
const TEXT_CHANNEL_TYPES = new Set([0, 5]); // text, announcement
const WAIT_FOR_SERVERS_MS = 8000;

if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const token = (process.env.GOON_DISCORD_BOT_TOKEN ?? '').trim();
const wanted = (process.env.GOON_DISCORD_CHANNEL_ID ?? '').trim();

if (typeof WebSocket === 'undefined') {
  console.error(`Node ${process.versions.node} has no built-in WebSocket; run this with Node 22 or newer.`);
  process.exit(1);
}
if (!isBotToken(token)) {
  console.error(
    'GOON_DISCORD_BOT_TOKEN is not set, or is not a bot token. Get one from the Developer Portal (your app > Bot > Reset Token)\n' +
      'and put it in .env in the repo root (gitignored) as GOON_DISCORD_BOT_TOKEN=... -- the application id and public key are not it.'
  );
  process.exit(1);
}

const ws = new WebSocket(GATEWAY);
let seq = null;
let heartbeat = null;
let ready = null;
const servers = [];
let finishTimer = null;

function send(op, d) {
  ws.send(JSON.stringify({ op, d }));
}

function finish() {
  clearInterval(heartbeat);
  clearTimeout(finishTimer);
  ws.close(1000);
  const appId = ready.application?.id ?? ready.user.id;
  console.log(`Logged in as ${ready.user.username} (application ${appId}). The bot can now post through the API.\n`);
  if (!servers.length) console.log('It is not in any server yet.');
  for (const s of servers.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`${s.name}  (server ${s.id})`);
    const channels = (s.channels ?? []).filter((c) => TEXT_CHANNEL_TYPES.has(c.type)).sort((a, b) => a.position - b.position);
    for (const c of channels) console.log(`  #${c.name.padEnd(30)} ${c.id}${c.id === wanted ? '   <- GOON_DISCORD_CHANNEL_ID' : ''}`);
    console.log('');
  }
  if (wanted && !servers.some((s) => s.channels?.some((c) => c.id === wanted))) {
    console.log(`GOON_DISCORD_CHANNEL_ID (${wanted}) is not a text channel in any of these servers.\n`);
  }
  console.log(
    `Invite it to a server (needs Manage Server there):\n` +
      `  https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${PERMISSIONS}`
  );
}

ws.addEventListener('message', (event) => {
  const { op, d, s, t } = JSON.parse(event.data);
  if (s != null) seq = s;
  if (op === 10) {
    heartbeat = setInterval(() => send(1, seq), d.heartbeat_interval);
    send(2, { token, intents: INTENT_GUILDS, properties: { os: process.platform, browser: 'goon-turismo', device: 'goon-turismo' } });
  } else if (op === 0 && t === 'READY') {
    ready = d;
    if (!d.guilds.length) return finish();
    finishTimer = setTimeout(finish, WAIT_FOR_SERVERS_MS); // servers that never come in are simply not listed
  } else if (op === 0 && t === 'GUILD_CREATE') {
    servers.push(d);
    if (ready && servers.length === ready.guilds.length) finish();
  } else if (op === 9) {
    console.error('Discord refused the session. Try again in a minute.');
    process.exit(1);
  }
});

ws.addEventListener('close', (event) => {
  clearInterval(heartbeat);
  if (event.code === 4004) {
    console.error('Discord rejected the token (4004). Reset it in the Developer Portal and update .env.');
    process.exit(1);
  }
  if (!ready) {
    console.error(`The gateway closed before logging in (${event.code} ${event.reason || ''}).`);
    process.exit(1);
  }
});
