// PC-T10 (12 §UC-PC-014) — the ONE home for writing image FILES.
//
// Image bytes leave the database: uploads become content-hash-named files in a
// persistent directory served by GET /api/images/:filename (routes/images.js),
// and the `image` columns hold the URL path string instead of inline base64.
//
// Filename = sha256(bytes) hex, first 32 chars, plus the canonical extension
// for the SNIFFED type (`detectImageMime` stays the one magic-bytes authority —
// SEC-H2; the client's claimed mime is never trusted). Consequences, all
// deliberate (spec text):
//   - identical bytes dedupe to one file;
//   - a REPLACED photo gets a NEW filename ⇒ a new URL ⇒ cache busting by
//     construction (safe to serve `immutable`);
//   - conversion and re-uploads are idempotent (file exists ⇒ skip the write).
//
// Orphan files are accepted (§Accepted risks): replacing a photo does not
// delete the old file — content-hash dedupe means two rows may share one file.
import { createHash } from 'crypto';
import { mkdirSync, existsSync, writeFileSync, renameSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { dbPath } from '../db/schema.js';
import { detectImageMime } from './image-upload.js';

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// Default: a SIBLING of the SQLite file — backend/src/db/uploads/ in
// prod/staging, and automatically next to the throwaway DB_PATH in e2e runs
// (which isolates test uploads per run). UPLOADS_DIR env overrides.
// resolve() on the override too: res.sendFile throws on relative paths and
// backup-db.sh must tar the same directory the app writes (review finding, PC-T10).
export const UPLOADS_DIR = resolve(process.env.UPLOADS_DIR || join(dirname(resolve(dbPath)), 'uploads'));

// Created on boot (this module loads with the first route that imports it).
mkdirSync(UPLOADS_DIR, { recursive: true });

// Store raw image bytes as a content-hash file. Returns { url } or { error }
// (non-raster refused — the existing SEC-H2 message).
export function storeImage(buffer) {
  const mime = detectImageMime(buffer);
  if (!mime) return { error: 'Neplatný typ obrázka (povolené: PNG, JPEG, GIF, WebP)' };
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  const filename = `${hash}.${EXT_BY_MIME[mime]}`;
  const path = join(UPLOADS_DIR, filename);
  if (!existsSync(path)) {
    // tmp + rename: a crash mid-write must never leave a TRUNCATED file under
    // its final content-hash name — a later re-run would "reuse" it by hash.
    // rename on the same filesystem is atomic; the write-order guarantee the
    // spec asks for (file fully written first, column second) starts here.
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, buffer);
    renameSync(tmp, path);
  }
  return { url: `/api/images/${filename}` };
}

// Drop-in replacement for imageFromUpload on the CONVERTED write paths:
// validates by magic bytes exactly as before, but stores a file and returns
// the URL as `image` instead of a data: URI.
export function imageUrlFromUpload(file) {
  if (!file || !file.buffer) {
    return { error: 'Neplatný typ obrázka (povolené: PNG, JPEG, GIF, WebP)' };
  }
  const stored = storeImage(file.buffer);
  if (stored.error) return { error: stored.error };
  return { image: stored.url };
}

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;

// Drop-in replacement for imageFromBody on the CONVERTED write paths. A body
// value that is already a plain URL/path passes through exactly as
// imageFromBody always did (it's a reference, not inline content); a data: URI
// is decoded, sniffed (the declared mime is ignored — SEC-H2) and stored as a
// file, so base64 never enters a column on these paths again.
export function imageUrlFromBody(value) {
  if (typeof value !== 'string' || !value) return { error: 'Neplatný obrázok' };
  if (!value.startsWith('data:')) return { image: value };
  const m = DATA_URI.exec(value);
  if (!m) return { error: 'Neplatný obrázok' };
  const stored = storeImage(Buffer.from(m[2], 'base64'));
  if (stored.error) return { error: stored.error };
  return { image: stored.url };
}
