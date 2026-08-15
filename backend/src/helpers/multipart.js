import multer from 'multer';

// FUP-T7: the ONE place a multipart upload middleware is built, and the one place
// a failure to parse an untrusted request body is attributed to the client.
//
// ── Why a wrapper and not another rule in the global handler ──────────────────
// FUP-T3 gave `index.js` a status-based rule (preserve any 4xx the error already
// carries) and FUP-T6 extended it to `MulterError` by mapping its `code`. Neither
// can see multer's THIRD failure family: for a body busboy cannot parse — a
// `multipart/form-data` Content-Type with no boundary, a truncated form, a
// malformed part header — and for the client hanging up mid-upload, multer calls
// `next(new Error(...))` with no `status` and no `code`. Those took the 500 branch
// WITH a full stack log, including the ordinary case of an admin's photo upload
// dropping on a flaky connection.
//
// The global handler cannot fix that on its own: a bare `Error` with no status is
// exactly what a genuine server fault looks like there (the CORS rejection is one,
// and every `throw` in this codebase is one), so a rule that read "bare Error ⇒
// 400" would hand a client-error verdict to real bugs across the whole app. The
// missing information is WHICH MIDDLEWARE FAILED, and only the call site has it.
// Hence a wrapper: it knows the error came out of the multipart body parser, and
// it gives the error a status so the translation still flows through FUP-T3's
// existing 4xx branch — inheriting both of that row's decisions for free (no stack
// log, and `err.message` never echoed to the caller).
//
// ⚠ NOT a match on busboy's message strings ("Multipart: Boundary not found",
// "Unexpected end of form", "Request aborted"). That brittle coupling is precisely
// what FUP-T3's status-based rule was chosen to avoid — a library copy-edit would
// silently restore the 500s with the suite still green. Everything below keys on
// structure: which middleware produced the error, and what kind of object it is.
//
// ── Building the multer instance here too, on purpose ─────────────────────────
// `routes/products.js` and `routes/bakery-products.js` each used to build their
// own identical `multer({ memoryStorage, 5 MB })`. Owning it here means there is
// no other way to obtain an upload middleware in this codebase, so a future upload
// route cannot accidentally opt out of the translation — the same argument FUP-T6
// made for putting its mapping in the one global handler. The 5 MB cap is
// unchanged (FUP-T6 pins it: over the cap is 413, and that path still runs through
// `MulterError`, untouched below).
export const UPLOAD_FILE_SIZE_LIMIT = 5 * 1024 * 1024;

// ⚠ `memoryStorage()` IS LOAD-BEARING FOR GATE 4 BELOW, not just a storage choice.
// `MemoryStorage._handleFile` never calls back with an error. `diskStorage` does —
// and Node's fs errors (ENOSPC, EACCES, EMFILE) are PLAIN `Error`s built by the same
// `uvException` as the connection errors gate 4 deliberately buckets as client
// events, and they arrive through `abortWithError` → this very callback. So a switch
// to `diskStorage` would report a full disk to the admin as `400 Neplatna
// poziadavka` with no stack — a server fault silently dressed as a client mistake,
// which is the dangerous direction. If storage ever changes, gate 4 must grow an
// exclusion (`err.syscall == null`) before it does.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_FILE_SIZE_LIMIT }
});

// Attribute a parse failure to the client — but fail CLOSED, keeping the 500 for
// anything that might be a genuine fault. Four structural gates, no message text:
//
//  1. Not an object → leave it; the global handler's 500 branch is the safe default.
//  2. Already carries `status`/`statusCode` → someone upstream has already decided;
//     never overwrite a verdict (FUP-T3's rule reads it first anyway).
//  3. A `MulterError` → FUP-T6 already maps it BY CODE, and that mapping is finer
//     than this one (LIMIT_FILE_SIZE is 413, not 400). Leave it alone.
//  4. Not a PLAIN `Error` → leave it. Every failure busboy and multer raise for bad
//     input is `new Error(...)` (verified against busboy 1.6 / multer 2.2: eight
//     `new Error` sites, all of them malformed-input or client-disconnect, plus
//     multer's own `Request aborted` / `Request closed` / `Request error`). A
//     SUBCLASS is what a real fault looks like here instead — `TypeError` from a
//     bug in our own options, `RangeError` from an allocation failure in
//     memoryStorage's concat — so a subclass keeps its 500 and its stack. A reword
//     upstream changes no message we read; a change of error CLASS only ever fails
//     closed.
//
// A libuv error (ECONNRESET on the request socket) is a plain `Error` with a `code`,
// so it lands in the client bucket. That is the intended reading: the connection
// carrying the body died, which is the same event as an abort, not a server fault.
function markMultipartClientError(err, req) {
  if (!err || typeof err !== 'object') return;
  if (err.status != null || err.statusCode != null) return;
  if (err instanceof multer.MulterError) return;
  if (err.constructor !== Error) return;

  err.status = 400;
  // The global handler logs `err.type || err.code || 'client-error'`, so this is the
  // whole diagnostic an operator gets — deliberately a structural fact rather than
  // the message. `req.complete` is Node's own "the whole request message arrived",
  // so, as observed live:
  //   multipart-malformed  — the body arrived in full and did not parse (a truncated
  //                          form, a bad part header): a client that builds bad requests.
  //   multipart-incomplete — the body had not arrived when the parser gave up: the
  //                          client disconnected mid-upload, OR busboy refused the
  //                          headers before reading a byte (no boundary in the
  //                          Content-Type), which is why this label is not by itself
  //                          proof of a dropped connection.
  // Telling those two apart used to require reading a stack, which is the cost this
  // row exists to remove.
  err.type = req && req.complete ? 'multipart-malformed' : 'multipart-incomplete';
}

// Drop-in for `multer(...).single(field)`: same middleware, but a parse failure is
// tagged before it reaches the global handler.
//
// ⚠ Only the PARSE is client-attributable. The wrapper's callback runs exactly once,
// when multer finishes; anything the route handler throws afterwards never passes
// through here and keeps its 500 — a real bug must not be able to hide behind a
// 400 just because it happened to sit behind an upload.
//
// Aborted requests are answered like any other 400. Responding to a socket that is
// already gone is harmless — Node's `OutgoingMessage._writeRaw` discards the write
// on a destroyed connection rather than throwing or emitting an unhandled error
// (verified live: the pre-fix 500 body was written to the same dead socket without
// incident). Swallowing the error instead would mean multer's `next(err)` never
// completing the request, and would cost the one log line that is the entire
// observable outcome of an abort.
export function uploadSingle(field) {
  const parseMultipart = upload.single(field);
  return function multipartUpload(req, res, next) {
    parseMultipart(req, res, (err) => {
      if (err) markMultipartClientError(err, req);
      next(err);
    });
  };
}
