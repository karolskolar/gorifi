// Image upload validation (SEC-H2, audit §M1). The client-supplied
// `req.file.mimetype` (and any `data:` URI in the body) is untrusted — a
// crafted `image/svg+xml` or `text/html` payload embedded in a data: URI could
// execute as stored XSS wherever the image is rendered. We instead sniff the
// actual bytes (magic numbers) and only allow raster image types.

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Detect a raster image type from the file's magic bytes; null if not allowed.
export function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  // GIF: 47 49 46 38 ("GIF8")
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
  // WebP: "RIFF" .... "WEBP"
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  return null;
}

// Build a data: URI from an uploaded file, validating its real type.
// Returns { image } or { error }.
export function imageFromUpload(file) {
  const mime = detectImageMime(file?.buffer);
  if (!mime) return { error: 'Neplatný typ obrázka (povolené: PNG, JPEG, GIF, WebP)' };
  return { image: `data:${mime};base64,${file.buffer.toString('base64')}` };
}

// Validate an image value supplied in the request body. A `data:` URI must be an
// allowed raster type; a plain URL/path is passed through (it's a reference, not
// inline executable content). Returns { image } or { error }.
export function imageFromBody(value) {
  if (typeof value !== 'string' || !value) return { error: 'Neplatný obrázok' };
  if (value.startsWith('data:')) {
    const m = /^data:([^;,]+)[;,]/.exec(value);
    if (!m || !ALLOWED_MIME.has(m[1].trim().toLowerCase())) {
      return { error: 'Neplatný typ obrázka (povolené: PNG, JPEG, GIF, WebP)' };
    }
  }
  return { image: value };
}
