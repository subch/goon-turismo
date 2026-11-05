#!/usr/bin/env node
/**
 * One Goon TT submission, the data side: read the screenshot, check it
 * against the Goon TT running now, and if it passes keep the screenshot as
 * proof and add the lap to data/goon-tt/. The outcome, with the Discord reply
 * for it, is written as JSON to --out the moment it is known; bot.mjs posts
 * that reply while sync.sh goes on to commit and publish.
 *
 *   node scripts/goon-tt/submit.mjs --image <file> --psn <psn> [--time 1:27.864]
 *        --via command|message --out <file> [--now <iso>] [--root <repo>]
 *
 * --time is the lap the driver typed (/goonttsubmit); without it (the
 * right-click submit) the lap is taken off the screenshot.
 * Exit 0: lap added. 3: refused, with reasons. Anything else: it broke.
 */
import { parseArgs } from 'node:util';
import { copyFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcr, readRecordsScreen } from './records-screen.mjs';
import { checkLap, sameCar } from './check-lap.mjs';
import { lapToMs, msToLap, runningTt } from './standings.mjs';
import { acceptedMessage, refusedMessage } from './discord.mjs';
import { REPO, loadGoonTts, saveGoonTt, loadRoster, loadPoints } from './data.mjs';

const PROOF_TYPES = new Set(['.jpg', '.jpeg', '.png']);

/** Resolves { ok, ttId, psn, lap?, reasons?, message }. Never throws for a bad screenshot, only for a broken setup. */
export async function submit({ root = REPO, image, psn, time = null, via, now = new Date(), ocr = null }) {
  const roster = await loadRoster(root);
  const points = await loadPoints(root);
  const refuse = (reasons, ttId = null) => ({ ok: false, ttId, psn, reasons, message: refusedMessage(psn, reasons, roster) });

  const tt = runningTt(await loadGoonTts(root), now);
  if (!tt) return refuse(['no Goon TT is running right now']);
  if (!roster.psns.has(psn)) return refuse([`${psn} is not on the roster`], tt.id);
  const typedMs = time ? lapToMs(time) : null;
  if (time && typedMs == null) return refuse([`couldn't make out the time "${time}"; write it like 1:27.864`], tt.id);
  const ext = path.extname(image).toLowerCase();
  if (!PROOF_TYPES.has(ext)) return refuse(['the screenshot needs to be a JPG or PNG'], tt.id);

  const own = !ocr;
  ocr ??= await createOcr();
  let check;
  try {
    const reading = await readRecordsScreen(image, { ocr, wantRow: ({ car }) => sameCar(car, tt.car) });
    check = checkLap(reading, tt, { typedMs });
  } finally {
    if (own) await ocr.terminate();
  }
  if (!check.ok) return refuse(check.reasons, tt.id);

  const { timeMs, setOn, setAt } = check.lap;
  if (tt.laps.some((l) => l.psn === psn && l.timeMs === timeMs)) {
    return refuse([`${msToLap(timeMs)} is already on the board`], tt.id);
  }

  const proof = `/goon-tt/${tt.id}/${psn}-${timeMs}${ext === '.jpeg' ? '.jpg' : ext}`;
  await mkdir(path.join(root, 'public', 'goon-tt', tt.id), { recursive: true });
  await copyFile(image, path.join(root, 'public', proof));
  const lap = { psn, timeMs, setOn, setAt, proof, submittedAt: now.toISOString().slice(0, 19) + 'Z', via };
  tt.laps.push(lap);
  await saveGoonTt(tt, root);
  return {
    ok: true,
    ttId: tt.id,
    psn,
    lap: { ...lap, time: msToLap(timeMs) },
    message: acceptedMessage(tt, psn, { ...lap, time: msToLap(timeMs) }, { name: roster.name, now, points }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({
    options: {
      image: { type: 'string' },
      psn: { type: 'string' },
      time: { type: 'string' },
      via: { type: 'string', default: 'command' },
      out: { type: 'string' },
      now: { type: 'string' },
      root: { type: 'string' },
    },
  });
  if (!v.image || !v.psn || !v.out || !['command', 'message', 'hand'].includes(v.via)) {
    console.error('usage: submit.mjs --image <file> --psn <psn> [--time 1:27.864] --via command|message --out <file>');
    process.exit(2);
  }
  const result = await submit({
    root: v.root ?? REPO,
    image: v.image,
    psn: v.psn,
    time: v.time ?? null,
    via: v.via,
    now: v.now ? new Date(v.now) : new Date(),
  });
  await writeFile(`${v.out}.tmp`, JSON.stringify(result, null, 2) + '\n');
  await rename(`${v.out}.tmp`, v.out);
  console.log(result.ok ? `Goon TT: ${v.psn} ${result.lap.time} added to ${result.ttId}` : `Goon TT: refused ${v.psn}: ${result.reasons.join('; ')}`);
  process.exit(result.ok ? 0 : 3);
}
