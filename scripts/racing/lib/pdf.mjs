// Text out of a results PDF. MotoAmerica publishes its classifications only
// as PDFs from its timing provider (MyLaps Orbits), so that adapter fetches
// the PDF and parses its text. pdf-parse is CommonJS; createRequire keeps the
// rest of the adapters plain ESM.
import { createRequire } from 'node:module';
import { request } from './http.mjs';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

/** Fetch a PDF and return its text, or null on a 404 (= not published yet). */
export async function getPdfText(url, opts = {}) {
  let res;
  try {
    res = await request(url, opts);
  } catch (err) {
    if (/HTTP 404/.test(err.message)) return null;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 || buf.subarray(0, 5).toString() !== '%PDF-') return null;
  const parsed = await pdfParse(buf);
  return parsed.text ?? '';
}

/** Non-empty, trimmed lines. */
export function lines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}
