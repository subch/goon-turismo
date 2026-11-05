#!/usr/bin/env node
/**
 * The bot's /goontt reply, as Discord message JSON on stdout: the running Goon
 * TT's board, or the latest one's when none is running.
 *
 *   node scripts/goon-tt/board.mjs [--now <iso>] [--root <repo>]
 */
import { parseArgs } from 'node:util';
import { boardMessage } from './discord.mjs';
import { runningTt } from './standings.mjs';
import { REPO, loadGoonTts, loadRoster, loadPoints } from './data.mjs';

const { values: v } = parseArgs({ options: { now: { type: 'string' }, root: { type: 'string' } } });
const root = v.root ?? REPO;
const now = v.now ? new Date(v.now) : new Date();
const tts = await loadGoonTts(root);
const { name } = await loadRoster(root);
const tt = runningTt(tts, now) ?? tts[0] ?? null;
console.log(JSON.stringify(boardMessage(tt, { name, now, points: await loadPoints(root) })));
