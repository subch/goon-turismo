#!/usr/bin/env node
/**
 * What the OCR reads off a GT7 records screenshot, as JSON -- for checking a
 * screenshot by hand and for tuning the reader.
 *
 *   node scripts/goon-tt/read-screenshot.mjs <image> [--car "Fairlady 240ZG"] [--debug <dir>]
 *
 * --car limits the full read (lap, date, tyres) to rows whose name contains
 * it; --debug writes every cut-out field there as the PNG Tesseract was given.
 */
import { parseArgs } from 'node:util';
import { createOcr, readRecordsScreen } from './records-screen.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { car: { type: 'string' }, debug: { type: 'string' } },
});
if (positionals.length !== 1) {
  console.error('usage: read-screenshot.mjs <image> [--car <name>] [--debug <dir>]');
  process.exit(2);
}
const want = values.car?.toLowerCase();
const ocr = await createOcr();
try {
  const result = await readRecordsScreen(positionals[0], {
    ocr,
    wantRow: ({ car }) => !want || car.toLowerCase().includes(want),
    debugDir: values.debug ?? null,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await ocr.terminate();
}
