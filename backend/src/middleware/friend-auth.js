import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '../db/schema.js';

// Session horizons (09 §UC-ML-002, ML-T1). ⚠ The flat 30-day session is
// RETIRED: 24 h is the default and 60 days is the explicit "Zapamätať si ma na
// tomto zariadení" opt-in. 60 days rather than 30 because cycles run ~monthly,
// so a remembered session has to span two of them (product decision
// 2026-08-14) — otherwise a friend who orders every cycle still re-logs-in.
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;          // 24 hours — the default
const SESSION_REMEMBER_MS = 60 * 24 * 60 * 60 * 1000;     // 60 days — the opt-in

// Get current auth mode from settings
export function getAuthMode() {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'auth_mode'").get();
  return (setting && setting.value) || 'legacy';
}

// Create a new session token for a friend (09 §UC-ML-002).
//
// opts.remember === true  ⇒ 60 days. ⚠ STRICT boolean, never a truthy check:
//   `remember` arrives from a JSON request body, and a mis-serialised checkbox
//   sends the STRING "false" — which is truthy, and would silently buy the
//   longest session the app can issue.
// opts.expiresAt (ms epoch) ⇒ that exact expiry. Used by the two endpoints that
//   invalidate and re-mint mid-session, so a remembered friend keeps the horizon
//   they opted into. A missing/NaN value falls through to the default rather
//   than writing a broken expiry.
// opts.via (string) ⇒ the provenance column; NULL when absent. ML-T1 never
//   passes it — ML-T3's redemption writes 'magic_link'. Kept value-agnostic
//   (module 10 may add 'google').
export function createFriendSession(friendId, opts = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  // ⚠ `> Date.now()` is not redundant with `Number.isFinite`. The opportunistic
  // cleanup below deletes rows whose `expires_at` has passed, so honouring a PAST
  // timestamp would delete the row this call just inserted and still return a
  // token — a 200 carrying a session that authenticates nowhere. Unreachable
  // today (`presentedSessionExpiry` already filters on `expires_at > Date.now()`,
  // and no route reads `expiresAt` from a request body), so this is the guard
  // matching what its comment claims rather than a live bug. (ML-T1 review.)
  const expiresAt = Number.isFinite(opts.expiresAt) && opts.expiresAt > Date.now()
    ? opts.expiresAt
    : Date.now() + (opts.remember === true ? SESSION_REMEMBER_MS : SESSION_DURATION_MS);
  const via = typeof opts.via === 'string' && opts.via ? opts.via : null;
  db.prepare('INSERT INTO friend_sessions (friend_id, token, expires_at, via) VALUES (?, ?, ?, ?)')
    .run(friendId, token, expiresAt, via);

  // Opportunistic cleanup of expired sessions
  db.prepare('DELETE FROM friend_sessions WHERE expires_at < ?').run(Date.now());

  return { token, expiresAt };
}

// The expiry of the session row the request is presenting, or null when the
// caller has no session (the legacy X-Friends-Password header resolves no row).
//
// ⚠ Must be called BEFORE invalidateFriendSessions() — the row it reads is one
// of the rows that call deletes. Only used by the two re-minting endpoints, to
// carry an opted-in 60-day horizon across a password change instead of silently
// shortening it to 24 h.
export function presentedSessionExpiry(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const row = db
    .prepare('SELECT expires_at FROM friend_sessions WHERE token = ? AND expires_at > ?')
    .get(authHeader.slice(7), Date.now());
  return row ? row.expires_at : null;
}

// The PROVENANCE of the session row the request is presenting (`friend_sessions.via`),
// or null when there is none — no Bearer header, an unknown/expired token, or a row
// minted by an ordinary login (09 §UC-ML-001: `via` is NULL everywhere except ML-T3's
// redemption, which writes 'magic_link').
//
// ⚠ THE ONLY INPUT TO §UC-ML-008's `currentPassword` WAIVER, and it reads the SESSION
// ROW on purpose. A body field would be a one-line bypass of password proof for anyone
// holding any friend session — which is precisely why resolved conflict #5 chose a
// provenance COLUMN over a parallel session type or a client flag. Nothing here may
// ever consult `req.body`.
//
// Value-agnostic, exactly like `createFriendSession`'s `via`: it hands back whatever
// the column holds so module 10 can add 'google' without touching this reader. The
// `expires_at > ?` predicate keeps it consistent with `validateFriendAuth` — an expired
// row authenticates nothing, so it must not carry a waiver either. That is the second
// of the waiver's two deaths (the first being the NULL-via re-mint on change-password).
export function presentedSessionVia(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const row = db
    .prepare('SELECT via FROM friend_sessions WHERE token = ? AND expires_at > ?')
    .get(authHeader.slice(7), Date.now());
  return row ? row.via : null;
}

// Invalidate all sessions for a friend
export function invalidateFriendSessions(friendId) {
  db.prepare('DELETE FROM friend_sessions WHERE friend_id = ?').run(friendId);
}

// Validate friend authentication from request headers
// Returns { valid: true, friendId } on success, or { error, status } on failure
export function validateFriendAuth(req) {
  // 1. Check for Bearer token
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const session = db.prepare('SELECT * FROM friend_sessions WHERE token = ? AND expires_at > ?').get(token, Date.now());
    if (session) {
      return { valid: true, friendId: session.friend_id };
    }
    // Token provided but invalid/expired
    return { error: 'Neplatny alebo expirovany token', status: 401 };
  }

  // 2. Fall back to X-Friends-Password header
  const password = req.headers['x-friends-password'];
  if (!password) {
    return { error: 'Neautorizovany pristup', status: 401 };
  }

  const authMode = getAuthMode();
  if (authMode === 'modern') {
    return { error: 'Spolocne heslo nie je povolene. Prihlaste sa menom a heslom.', status: 401 };
  }

  const setting = db.prepare("SELECT value FROM settings WHERE key = 'friends_password'").get();
  if (!setting || !setting.value) {
    return { error: 'Heslo pre priatelov nie je nastavene', status: 400 };
  }

  if (password !== setting.value) {
    return { error: 'Nespravne heslo', status: 401 };
  }

  return { valid: true };
}

// Require an authenticated friend who OWNS the target resource.
// - Token (Bearer) auth resolves a concrete friendId → it must equal targetId,
//   otherwise 403. This closes friend-vs-friend IDOR for logged-in friends.
// - Shared-password auth (no friendId) is allowed ONLY in legacy mode, as a
//   migration window; in 'modern' mode it is rejected (401) so callers must use
//   their own token. Once the admin flips auth_mode to 'modern' the IDOR is
//   fully closed.
// Returns { friendId } on success (friendId may be null in the legacy window),
// or { error, status } on failure.
export function requireFriendOwner(req, targetId) {
  const v = validateFriendAuth(req);
  if (v.error) return { error: v.error, status: v.status };

  if (v.friendId != null) {
    if (String(v.friendId) !== String(targetId)) {
      return { error: 'Nemáte oprávnenie na tento účet', status: 403 };
    }
    return { friendId: v.friendId };
  }

  // No per-friend identity (shared password).
  if (getAuthMode() === 'modern') {
    return { error: 'Prihláste sa svojím menom a heslom', status: 401 };
  }
  return { friendId: null };
}

// Require an authenticated friend with a RESOLVED per-friend identity — the
// "host" of a guest share link and of the sub-orders hanging off it.
//
// Unlike requireFriendOwner there is no target id in the URL to compare against
// (the guest-link endpoints are keyed on /cycle/:cycleId, and the host is simply
// whoever is authenticated), so:
// - Bearer (friend_sessions) auth resolves a concrete friendId → that friend is
//   the host.
// - Bare shared-password auth resolves no friendId, so there would be no host to
//   attribute the link to. Taking a friend_id from the request body instead
//   would reintroduce exactly the friend-vs-friend IDOR that SEC-A1 closed, so
//   this is rejected with 401 even in legacy mode. POST /friends/auth issues a
//   per-friend session token in BOTH login modes (personal username login and
//   legacy shared password + friend selection), so every real user has a token.
//
// Callers then compare the resolved friendId against the row's ownership
// (`guest_order_links.host_friend_id`) and answer 403 for anybody else.
// Shared by routes/guest-links.js (GSO-T2) and routes/guest-orders.js (GSO-T5) —
// there must only ever be one of these.
export function requireHost(req) {
  const v = validateFriendAuth(req);
  if (v.error) return { error: v.error, status: v.status };
  if (v.friendId == null) {
    return { error: 'Prihláste sa svojím menom, aby sme vedeli, koho odkaz to je', status: 401 };
  }
  return { friendId: v.friendId };
}

// Validate username format
export function validateUsername(username) {
  if (!username || typeof username !== 'string') {
    return 'Uzivatelske meno je povinne';
  }
  if (username.length < 3 || username.length > 30) {
    return 'Uzivatelske meno musi mat 3-30 znakov';
  }
  if (!/^[a-z0-9._-]+$/.test(username)) {
    return 'Uzivatelske meno moze obsahovat len male pismena, cisla, bodku, podtrznik a pomlcku';
  }
  return null;
}

// Check if username is already taken (excluding a specific friend ID)
export function isUsernameTaken(username, excludeFriendId = null) {
  const query = excludeFriendId
    ? db.prepare('SELECT id FROM friends WHERE username = ? AND id != ?').get(username, excludeFriendId)
    : db.prepare('SELECT id FROM friends WHERE username = ?').get(username);
  return !!query;
}

// Hash a password
export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

// Compare password against hash
export function comparePassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}
