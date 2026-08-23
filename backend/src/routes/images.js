// PC-T10 (12 §UC-PC-014) — serve product image files.
//
// ⚠ DELIBERATELY PUBLIC (mounted BARE, no requireAdmin) and DELIBERATELY NOT in
// ADMIN_ENDPOINTS: friend AND guest pages render these images, and the exposure
// is EQUIVALENT to today's — GET /api/products/cycle/:id is already a public
// route that shipped the same bytes inline as base64. Recorded here and in the
// spec so the ADMIN_ENDPOINTS sweep's reviewer doesn't "fix" it.
//
// A validated ROUTE, not an express.static mount (house hostile-boundary
// style): the strict filename regex forecloses path traversal by construction —
// no separator (or anything else) can appear. Content-Type comes from the
// extension, which is TRUSTED because it was derived from sniffed magic bytes
// at write time (helpers/image-store.js), never from client input.
import { Router } from 'express';
import { join } from 'path';
import { existsSync } from 'fs';
import { UPLOADS_DIR } from '../helpers/image-store.js';

const router = Router();

const FILENAME = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;

router.get('/:filename', (req, res) => {
  const { filename } = req.params;
  if (!FILENAME.test(filename)) {
    return res.status(404).json({ error: 'Obrázok neexistuje' });
  }
  const path = join(UPLOADS_DIR, filename);
  if (!existsSync(path)) {
    return res.status(404).json({ error: 'Obrázok neexistuje' });
  }
  // Cache-Control: public, max-age=31536000, immutable — safe ONLY because the
  // filename is a content hash: a replaced photo gets a NEW filename ⇒ a new
  // URL, so this URL's bytes can never change (cache busting by construction).
  // Express sends the header itself; nginx's `location /api` adds none of its
  // own, so nothing overrides it.
  res.sendFile(path, { maxAge: '365d', immutable: true }, (err) => {
    // Race: the existsSync check passed but the file vanished before sendFile.
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'Obrázok neexistuje' });
    }
  });
});

export default router;
