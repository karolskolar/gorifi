import { Router } from 'express';
import db from '../db/schema.js';
import crypto from 'crypto';
import { requireAdmin } from '../middleware/admin-auth.js';
import { authLimiter } from '../middleware/rate-limit.js';
import { hashPassword as bcryptHash, comparePassword as bcryptCompare } from '../middleware/friend-auth.js';
import { bindValue } from '../helpers/bind-value.js';

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

  // Generate a simple session token
  const token = crypto.randomBytes(32).toString('hex');

  // Store token (expires in 7 days)
  const expiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_token', ?)").run(
    JSON.stringify({ token, expiry })
  );

  res.json({ token });
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
