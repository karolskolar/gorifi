import { Router } from 'express';
import db from '../db/schema.js';
import crypto from 'crypto';
import { requireAdmin } from '../middleware/admin-auth.js';
import { authLimiter } from '../middleware/rate-limit.js';
import { hashPassword as bcryptHash, comparePassword as bcryptCompare } from '../middleware/friend-auth.js';
import { bindValue } from '../helpers/bind-value.js';
import { requireGoogleAuthConfigured, verifyGoogleIdToken } from '../helpers/google-auth.js';

const router = Router();

// Admin passwords are stored as bcrypt (SEC-S1). Pre-existing passwords hashed
// with unsalted SHA-256 are transparently re-hashed to bcrypt on next login.
const ADMIN_MIN_LENGTH = 10;

// Legacy unsalted SHA-256 — only used to verify (and then migrate) old hashes.
const legacySha256 = (password) => crypto.createHash('sha256').update(password).digest('hex');

// True if a stored hash is bcrypt (vs the legacy SHA-256 hex).
const isBcryptHash = (hash) => typeof hash === 'string' && hash.startsWith('$2');

// Verify a plaintext admin password against a stored hash (bcrypt or legacy).
//
// ⚠ THE TYPE GUARD SITS ABOVE THE BRANCH, AND IT HAS TO (FUP-T11). `comparePassword`
// now refuses a non-string itself, which covers the bcrypt branch — but the LEGACY
// SHA-256 branch never touches bcrypt at all: `crypto.createHash().update(value)`
// raises its own `TypeError: The "data" argument must be of type string…`. So a
// guard placed only in the helper would have left every legacy-hashed instance
// still answering 500 with a full stack, on `POST /api/admin/login`, which needs no
// credentials and no precondition — a free remote log-flood (verified: both branches
// throw on `{length:12}`, a number, an array and `true`; only the exception class
// differs). Guarding here closes BOTH branches with one line, for both callers
// (`/login` and `/change-password`'s `currentPassword`).
//
// `false` is the correct answer, not a convenient one: no non-string could ever have
// matched a digest, so this cannot loosen anything. It lands on each caller's
// existing 401 with each caller's existing message — the same message a merely wrong
// password gets, so no new oracle appears on the app's most exposed endpoint.
function verifyAdminPassword(password, storedHash) {
  if (typeof password !== 'string') return false;
  if (isBcryptHash(storedHash)) {
    return bcryptCompare(password, storedHash);
  }
  // Legacy SHA-256: constant-time compare of the hex digests.
  const a = Buffer.from(legacySha256(password));
  const b = Buffer.from(String(storedHash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ⚠ THE ONE ADMIN SESSION MINT, AND IT IS DELIBERATELY A FUNCTION (10 §UC-GA-011).
//
// The spec says the Google login's mint is "byte-identical to the password login's
// (`admin.js:80-89`)". Sharing the code is what makes that TRUE BY CONSTRUCTION rather
// than true until somebody edits one of two copies: 32 random bytes as hex, a 7-day
// expiry, one `INSERT OR REPLACE` into `settings('admin_token')`, and a bare
// `{ token }` response at each call site.
//
// ⚠ THERE IS EXACTLY ONE ADMIN TOKEN APP-WIDE — the `INSERT OR REPLACE` on a single
// settings row is what makes that so. A Google login therefore invalidates a token
// minted earlier by a password login, and vice versa, exactly as a second password
// login already did. KNOWN BEHAVIOUR, NOT A BUG (§UC-GA-011 restates it because the
// e2e harness trips on it); `google-auth.spec.js` asserts BOTH directions rather than
// working around them.
const ADMIN_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function mintAdminToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const expiry = Date.now() + ADMIN_SESSION_MS;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_token', ?)").run(
    JSON.stringify({ token, expiry })
  );
  return token;
}

// ═════════════════════════════════════════════════════════════════════════════
// 10 §UC-GA-010 — the admin Google allowlist (settings key `admin_google_subs`)
// ═════════════════════════════════════════════════════════════════════════════
//
// A JSON array of `{ sub, email, added_at }`. Empty or absent ⇒ nobody logs into the
// admin portal via Google, and `POST /google-login` below always 401s.
//
// ⚠ `sub` is the ONLY identity key (01 §Auth extensions) and it NEVER leaves the
// server: `publicAllowlist()` is the single projection every response goes through.
// The e-mail is the display AND the deletion handle, which is why an identity with no
// VERIFIED address is refused at the door (see the POST) — an entry that cannot be
// named cannot be revoked, and an admin ACL with no way out is worse than a missing
// feature.
const ADMIN_GOOGLE_SUBS_KEY = 'admin_google_subs';
const ADMIN_GOOGLE_DENIED = 'Tento Google účet nemá prístup do administrácie';
const ADMIN_GOOGLE_NO_EMAIL = 'Tento Google účet nemá overenú e-mailovú adresu, nedá sa pridať do zoznamu';
const ADMIN_GOOGLE_EMAIL_TAKEN = 'Tento e-mail už v zozname patrí inému Google účtu. Najprv odoberte pôvodný záznam.';

// ⚠ FAILS CLOSED AND FAILS QUIET. A hand-edited or truncated settings value must not
// 500 the admin settings page (the operator's only route back to a working state), and
// it must certainly not grant anybody anything — an unreadable ACL is an EMPTY ACL.
// Malformed individual entries are dropped for the same reason: an entry with no `sub`
// can never match a login, and an entry with no `email` can never be deleted.
function readAdminGoogleSubs() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(ADMIN_GOOGLE_SUBS_KEY);
  if (!row || typeof row.value !== 'string' || !row.value.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(row.value);
  } catch (e) {
    console.error('[admin] admin_google_subs is not valid JSON — treating the allowlist as EMPTY');
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry) =>
    entry && typeof entry === 'object'
    && typeof entry.sub === 'string' && entry.sub
    && typeof entry.email === 'string' && entry.email
  ).map((entry) => ({
    sub: entry.sub,
    email: entry.email,
    added_at: typeof entry.added_at === 'string' ? entry.added_at : null,
  }));
}

function writeAdminGoogleSubs(entries) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    ADMIN_GOOGLE_SUBS_KEY,
    JSON.stringify(entries)
  );
}

// ⚠ THE STRIP (§UC-GA-010, the module-11 strip rule extended to admin subs). EVERY
// response that carries the allowlist goes through this one projection — GET, POST and
// DELETE alike — so `google-auth.spec.js`'s raw-text `/"sub"/` pin covers all three and
// a future `res.json({ entries })` on the raw array fails loudly.
function publicAllowlist(entries) {
  return entries.map((entry) => ({ email: entry.email, added_at: entry.added_at }));
}

// GET /api/admin/google-allowlist — who may enter with Google.
//
// ⚠ NO Google config guard, deliberately. Reading (and, below, REVOKING) the ACL is
// pure settings work with no outbound dependency; gating it on `GOOGLE_CLIENT_ID`
// would mean an operator who unsets the env can no longer see — or remove — the
// entries that are already there.
router.get('/google-allowlist', requireAdmin, (req, res) => {
  res.json({ entries: publicAllowlist(readAdminGoogleSubs()) });
});

// POST /api/admin/google-allowlist — body `{ id_token }`.
//
// ⚠ THE ADMIN PROVES POSSESSION OF THE ACCOUNT BEING ADDED. There is no hand-typed
// identity anywhere in this feature and there must never be one: 01's "e-mails
// confirmed at link time" means the `sub` comes out of a verified ID token, never out
// of a form, and matching is never done on an e-mail address.
//
// ⚠ GUARD ORDER — `requireAdmin` BEFORE `authLimiter`, unlike the two public login
// routes. §UC-GA-013 puts this endpoint on `authLimiter` because it accepts an ID
// token; running the ownership guard first means an ANONYMOUS caller cannot spend the
// office's shared 20/window bucket (which would lock the admin out of password login
// from the same NAT), and it keeps `api-security.spec.js`'s anonymous sweep answering
// 401 rather than an occasional 429.
router.post('/google-allowlist', requireAdmin, authLimiter, async (req, res) => {
  // ⚠ THE MODULE-10 async WRAPPER (GA-T4's pattern, inherited verbatim). Express 4
  // does not forward a rejected handler promise to the error middleware and the
  // process runs under Node 20's default `--unhandled-rejections=throw`, so a throw
  // anywhere after the `await` would leave the client with no response AND kill the
  // process. No attacker-reachable throw exists today; the wrapper is here because
  // that is a property of this code, not of the route.
  try {
    const notConfigured = requireGoogleAuthConfigured();
    if (notConfigured) {
      return res.status(notConfigured.status).json({ error: notConfigured.error });
    }

    // ⚠ network I/O — MUST stay outside any db.transaction (helpers/google-auth.js,
    // the IA-T3 structural rule). It is also the ONLY `await` in this handler, which
    // is what the read-modify-write below depends on — see the note there.
    // ⚠ The result is ALWAYS TRUTHY — branch on `.error`, never on falsiness.
    const v = await verifyGoogleIdToken(req.body?.id_token);
    if (v.error) {
      return res.status(v.status).json({ error: v.error, ...(v.field && { field: v.field }) });
    }

    // §UC-GA-002: `email` survives verification only when `email_verified` is true.
    // §UC-GA-010 makes that address the deletion handle, so an entry without one would
    // be permanently unrevokable through this API — refuse the ADD instead.
    if (!v.identity.email) {
      return res.status(400).json({ error: ADMIN_GOOGLE_NO_EMAIL, field: 'email' });
    }

    // ⚠⚠ READ-MODIFY-WRITE, AND THE `await` IS ABOVE IT ON PURPOSE (the GA-T8 lesson).
    // The whole allowlist is ONE settings row, so "read it, change it, write it back"
    // is exactly the shape that loses a concurrent write. The repo's standing
    // `instances: 1` safety argument only holds while the check and the write are in
    // ONE SYNCHRONOUS RUN — an `await` between them yields the event loop and two
    // interleaved adds would silently drop one. There is deliberately NO await below
    // this line, and the whole sequence additionally runs inside a transaction so the
    // read and the write cannot be separated at the SQLite level either.
    const result = db.transaction(() => {
      const current = readAdminGoogleSubs();
      const existing = current.findIndex((entry) => entry.sub === v.identity.sub);

      // ⚠ ONE E-MAIL, ONE ENTRY — because the e-mail is the DELETION HANDLE and
      // nothing else is. `sub` is the identity key, so two subs CAN legitimately carry
      // the same address (a Workspace address freed by a deleted account and later
      // reassigned). Storing both would leave the list showing two rows an admin
      // cannot tell apart and `DELETE { email }` removing BOTH, with no way to remove
      // one — an access-control list that misrepresents its own state and a removal
      // that is not what was asked for. Refusing costs one 409 with an obvious remedy
      // (revoke the stale row first); accepting is unrecoverable through the API.
      // ⚠ Scoped to a DIFFERENT sub, so the same account re-adding its own address is
      // still the idempotent 200 below.
      if (current.some((entry) => entry.email === v.identity.email && entry.sub !== v.identity.sub)) {
        // Nothing is written — a transaction that only reads.
        return { conflict: true };
      }

      if (existing >= 0) {
        // Duplicate `sub` ⇒ idempotent 200 (§UC-GA-010): the same person, possibly a
        // newer e-mail. `added_at` stays put — it is the same entry, not a new one.
        current[existing] = { ...current[existing], email: v.identity.email };
      } else {
        current.push({ sub: v.identity.sub, email: v.identity.email, added_at: new Date().toISOString() });
      }
      writeAdminGoogleSubs(current);
      return { entries: current };
    })();

    if (result.conflict) {
      // Names only the address the admin just signed in with — which they already
      // know — and nothing about the identity that holds it. No `sub`, as everywhere.
      return res.status(409).json({ error: ADMIN_GOOGLE_EMAIL_TAKEN, field: 'email' });
    }

    return res.json({ entries: publicAllowlist(result.entries) });
  } catch (e) {
    // The token is never logged (it is a live credential) — `e.message` only, the
    // FUP-T3/FUP-T7 bounded-log rule.
    console.error(`[admin] google allowlist add failed: ${String(e?.message || e).slice(0, 300)}`);
    return res.status(500).json({ error: 'Účet sa nepodarilo pridať' });
  }
});

// DELETE /api/admin/google-allowlist — body `{ email }`.
//
// ⚠ REMOVING THE LAST ENTRY IS ALLOWED, and there is no "you would lock yourself out"
// guard by design: password auth is the PERMANENT backup (brief item 3), so Google
// lockout is recoverable. A guard here would be protecting against a state the design
// deliberately permits.
//
// Fully synchronous — no verification, no `await`, so the read-modify-write is atomic
// in-process by construction. No Google config guard either: revocation must never
// depend on an outbound service being configured or reachable.
router.delete('/google-allowlist', requireAdmin, (req, res) => {
  const email = req.body?.email;
  // The FUP-T13/T15 family: `{ email: {} }` must be a 400, never a 500 and never a
  // silent no-op that reads as a successful removal.
  if (typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'E-mailová adresa je povinná', field: 'email' });
  }
  const wanted = email.trim();

  const entries = db.transaction(() => {
    const kept = readAdminGoogleSubs().filter((entry) => entry.email !== wanted);
    writeAdminGoogleSubs(kept);
    return kept;
  })();

  // 200 whether or not anything matched (§UC-GA-010: idempotent when absent) — the
  // caller asked for a state, and that state now holds.
  res.json({ entries: publicAllowlist(entries) });
});

// POST /api/admin/google-login — PUBLIC (§UC-GA-013 obligation 1), `authLimiter`.
//
// ⚠ THIS ROUTE MUST NEVER JOIN `ADMIN_ENDPOINTS`: an anonymous caller has to reach the
// handler, or nobody could ever log in with it. Its 401 is the ALLOWLIST's message,
// which is what distinguishes "the handler refused you" from `requireAdmin`'s
// "Neautorizovaný prístup".
//
// ⚠ NO AUTH-MODE DEPENDENCY, and that is not an oversight. `auth_mode` governs the
// FRIEND surface only — resolved decision #2 (Google login is modern-mode only) is
// about friends, whose legacy alternative is a SHARED password with no per-person
// identity for Google to be an alternative credential for. The admin has always had a
// personal credential, so the flip is irrelevant here. Do NOT copy `friends.js`'s mode
// gate into this handler.
router.post('/google-login', authLimiter, async (req, res) => {
  try {
    const notConfigured = requireGoogleAuthConfigured();
    if (notConfigured) {
      return res.status(notConfigured.status).json({ error: notConfigured.error });
    }

    // ⚠ network I/O — MUST stay outside any db.transaction (helpers/google-auth.js).
    // 400 for a malformed token, 401 for one that does not verify, 503 for a Google
    // OUTAGE — an outage must never read as "wrong credentials".
    const v = await verifyGoogleIdToken(req.body?.id_token);
    if (v.error) {
      return res.status(v.status).json({ error: v.error, ...(v.field && { field: v.field }) });
    }

    // The `sub`, never the e-mail (01 §Auth extensions). An empty/absent allowlist
    // matches nothing, which is exactly why emptying it is a safe operation.
    const allowed = readAdminGoogleSubs().some((entry) => entry.sub === v.identity.sub);
    if (!allowed) {
      // One sentence, naming nobody: this 401 must not become a directory of who IS
      // allowed in.
      return res.status(401).json({ error: ADMIN_GOOGLE_DENIED });
    }

    // No new session machinery, no allowlist mutation, no settings write beyond the
    // token itself (§UC-GA-011).
    return res.json({ token: mintAdminToken() });
  } catch (e) {
    console.error(`[admin] google login failed: ${String(e?.message || e).slice(0, 300)}`);
    return res.status(500).json({ error: 'Prihlásenie zlyhalo' });
  }
});

// Check if admin password is set
router.get('/setup-status', (req, res) => {
  const setting = db.prepare("SELECT * FROM settings WHERE key = 'admin_password'").get();
  res.json({ isSetup: !!setting });
});

// Initial setup - set admin password
router.post('/setup', (req, res) => {
  const { password } = req.body;

  if (!password || password.length < ADMIN_MIN_LENGTH) {
    return res.status(400).json({ error: `Heslo musí mať aspoň ${ADMIN_MIN_LENGTH} znakov` });
  }

  // Check if already set up
  const existing = db.prepare("SELECT * FROM settings WHERE key = 'admin_password'").get();
  if (existing) {
    return res.status(400).json({ error: 'Admin uz je nastaveny' });
  }

  const hashedPassword = bcryptHash(password);
  db.prepare("INSERT INTO settings (key, value) VALUES ('admin_password', ?)").run(hashedPassword);

  res.json({ success: true, message: 'Admin heslo bolo nastavene' });
});

// Login (rate-limited against brute force)
router.post('/login', authLimiter, (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Heslo je povinne' });
  }

  const setting = db.prepare("SELECT * FROM settings WHERE key = 'admin_password'").get();

  if (!setting) {
    return res.status(400).json({ error: 'Admin nie je nastaveny' });
  }

  if (!verifyAdminPassword(password, setting.value)) {
    return res.status(401).json({ error: 'Nespravne heslo' });
  }

  // Transparent migration: upgrade a legacy SHA-256 hash to bcrypt on success.
  if (!isBcryptHash(setting.value)) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'admin_password'").run(bcryptHash(password));
  }

  // Generate a simple session token (32 random bytes, 7-day expiry, one settings
  // row). ⚠ `mintAdminToken()` is shared with `POST /google-login` (10 §UC-GA-011),
  // which is what makes "the Google mint is byte-identical to the password mint" true
  // by construction instead of true until one of two copies is edited.
  res.json({ token: mintAdminToken() });
});

// Verify token
router.post('/verify', (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(401).json({ valid: false });
  }

  const setting = db.prepare("SELECT * FROM settings WHERE key = 'admin_token'").get();

  if (!setting) {
    return res.status(401).json({ valid: false });
  }

  try {
    const { token: storedToken, expiry } = JSON.parse(setting.value);

    if (token === storedToken && Date.now() < expiry) {
      return res.json({ valid: true });
    }
  } catch (e) {
    // Invalid token format
  }

  res.status(401).json({ valid: false });
});

// Logout
router.post('/logout', (req, res) => {
  db.prepare("DELETE FROM settings WHERE key = 'admin_token'").run();
  res.json({ success: true });
});

// Get admin settings (friends_password, etc.) — admin only (returns secrets)
router.get('/settings', requireAdmin, (req, res) => {
  const friendsPassword = db.prepare("SELECT value FROM settings WHERE key = 'friends_password'").get();
  const paymentIban = db.prepare("SELECT value FROM settings WHERE key = 'payment_iban'").get();
  const paymentRevolutUsername = db.prepare("SELECT value FROM settings WHERE key = 'payment_revolut_username'").get();
  const authMode = db.prepare("SELECT value FROM settings WHERE key = 'auth_mode'").get();

  res.json({
    friendsPassword: friendsPassword?.value || '',
    paymentIban: paymentIban?.value || '',
    paymentRevolutUsername: paymentRevolutUsername?.value || '',
    authMode: authMode?.value || 'legacy'
  });
});

// Public payment settings (no auth required)
router.get('/payment-settings', (req, res) => {
  const paymentIban = db.prepare("SELECT value FROM settings WHERE key = 'payment_iban'").get();
  const paymentRevolutUsername = db.prepare("SELECT value FROM settings WHERE key = 'payment_revolut_username'").get();

  res.json({
    paymentIban: paymentIban?.value || '',
    paymentRevolutUsername: paymentRevolutUsername?.value || ''
  });
});

// Update admin settings — admin only (can change friends password + payment IBAN)
router.put('/settings', requireAdmin, (req, res) => {
  // ⚠ FUP-T13 — THE MOST DANGEROUS COERCION IN THAT ROW, which is why the guard is
  // `bindValue` and not a `|| ''` tidy-up. All three go straight into an
  // INSERT OR REPLACE, so `{}` / `true` / an array was a 500 + stack — but mapping
  // them to `''` instead would have answered a clean 200 while BLANKING THE FRIENDS
  // PASSWORD for the whole instance, a live credential, with nothing in the status to
  // show for it. Unbindable ⇒ `undefined` ⇒ the `!== undefined` gate below skips the
  // write entirely and the stored setting survives. The response still echoes
  // `x || ''`, which is exactly what it already answered for an ABSENT field, so that
  // line needs no change. `authMode` is allow-listed below and is not bound raw.
  const friendsPassword = bindValue(req.body.friendsPassword);
  const paymentIban = bindValue(req.body.paymentIban);
  const paymentRevolutUsername = bindValue(req.body.paymentRevolutUsername);

  if (friendsPassword !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('friends_password', ?)").run(friendsPassword || '');
  }
  if (paymentIban !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('payment_iban', ?)").run(paymentIban || '');
  }
  if (paymentRevolutUsername !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('payment_revolut_username', ?)").run(paymentRevolutUsername || '');
  }
  if (req.body.authMode !== undefined) {
    const validModes = ['legacy', 'transition', 'modern'];
    const mode = validModes.includes(req.body.authMode) ? req.body.authMode : 'legacy';
    const previousMode = db.prepare("SELECT value FROM settings WHERE key = 'auth_mode'").get();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('auth_mode', ?)").run(mode);
    // Invalidate all friend sessions on mode change to force re-login
    if (previousMode?.value !== mode) {
      db.prepare('DELETE FROM friend_sessions').run();
    }
  }

  const currentAuthMode = db.prepare("SELECT value FROM settings WHERE key = 'auth_mode'").get();
  res.json({
    success: true,
    friendsPassword: friendsPassword || '',
    paymentIban: paymentIban || '',
    paymentRevolutUsername: paymentRevolutUsername || '',
    authMode: currentAuthMode?.value || 'legacy'
  });
});

// Change password (requires valid admin session AND current password)
router.post('/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Obe hesla su povinne' });
  }

  // ⚠ Type-guard BEFORE `bcryptHash` (FUP-T11), the HASH half of the split — see the
  // note on `hashPassword` in `middleware/friend-auth.js` for why this cannot live in
  // the helper the way the compare guard does. `newPassword.length < ADMIN_MIN_LENGTH`
  // read `.length` off whatever the body carried, so `{"newPassword":{"length":12}}`
  // cleared it — and so did a number and `true`, whose `.length` is `undefined` and
  // `undefined < 10` is `false`. All three reached `bcrypt.hashSync`, which throws
  // `Illegal arguments` ⇒ 500 plus a stack log for a malformed body. `currentPassword`
  // is already handled one branch below, by `verifyAdminPassword`'s own guard.
  // Nothing is loosened: the status and the message are unchanged, a short string
  // still 400s here, an empty/absent one still 400s with 'Obe hesla su povinne'
  // above, and a valid one still changes the password — only non-strings move
  // 500 → 400.
  if (typeof newPassword !== 'string' || newPassword.length < ADMIN_MIN_LENGTH) {
    return res.status(400).json({ error: `Nové heslo musí mať aspoň ${ADMIN_MIN_LENGTH} znakov` });
  }

  const setting = db.prepare("SELECT * FROM settings WHERE key = 'admin_password'").get();

  if (!setting) {
    return res.status(400).json({ error: 'Admin nie je nastaveny' });
  }

  if (!verifyAdminPassword(currentPassword, setting.value)) {
    return res.status(401).json({ error: 'Nespravne aktualne heslo' });
  }

  const hashedNew = bcryptHash(newPassword);
  db.prepare("UPDATE settings SET value = ? WHERE key = 'admin_password'").run(hashedNew);

  // Invalidate token
  db.prepare("DELETE FROM settings WHERE key = 'admin_token'").run();

  res.json({ success: true, message: 'Heslo bolo zmenene' });
});

export default router;
