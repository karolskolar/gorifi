import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '../db/schema.js';

// Session horizons (09 §UC-ML-002, ML-T1). ⚠ The flat 30-day session is
// RETIRED: 24 h is the default and 60 days is the explicit "Zapamätať si ma na
// tomto zariadení" opt-in. 60 days rather than 30 because cycles run ~monthly,
// so a remembered session has to span two of them (product decision
// 2026-08-14) — otherwise a friend who orders every cycle still re-logs-in.
// ⚠ Google logins opt in BY CONSTRUCTION (product decision 2026-08-20):
// POST /friends/auth/google always mints the 60-day horizon — the checkbox
// belongs to the password group and Google users never saw it. Password and
// shared-password logins keep the explicit opt-in.
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

// Drop every OUTSTANDING magic link for a friend (09 §UC-ML-009 rules 2-3, ML-T7).
// THE one home for this delete outside `magic-link.js`'s own predecessor invalidation
// — every caller is a `friends.password_hash` write or a deactivation, and each one
// runs it INSIDE the same transaction as that write (see the call sites in
// `friends.js`). Rationale: a password change is the "I have secured my account"
// event, so a link mailed before it must not outlive it.
//
// ⚠ THIS IS CONSERVATIVE HYGIENE, NOT THE LOAD-BEARING GATE. Redemption's own checks
// (§UC-ML-005: `active = 1` and a non-null `password_hash`, re-read inside the burn
// transaction in `magic-link.js`) are what actually refuse an inactive or ineligible
// friend, and an inactive friend can neither request nor redeem. Do not relax those
// on the strength of these deletes.
//
// ⚠ Scoped `used_at IS NULL`, matching `magic-link.js`'s predecessor invalidation
// verbatim: "outstanding" is this module's word for a redeemable row, and a burned row
// is already unredeemable (the `used_at IS NULL` predicate in the redeem UPDATE refuses
// it), so deleting it would buy nothing. What the scope preserves is exactly the
// `created_at` of BURNED rows, which a blanket delete would additionally discard.
//
// ⚠ IT DOES NOT MAKE THE 60 s COOLDOWN SURVIVE THIS EVENT, and do not read it that
// way. The cooldown is `MAX(created_at)` over ALL of the friend's rows, and in the
// normal sequence (request → password change) the newest row IS the outstanding one —
// so the scoped delete resets the cooldown exactly as a blanket delete would, and a
// request immediately afterwards mints a new row inside the 60 s window (measured).
// That is harmless: every route calling this requires the friend's own session or an
// admin token, so there is no anonymous abuse vector behind it.
//
// Burned rows are reclaimed by the opportunistic GC once they expire (§UC-ML-009
// rule 5; no scheduler exists in this stack and none is added).
export function invalidateLoginTokens(friendId) {
  db.prepare('DELETE FROM login_tokens WHERE friend_id = ? AND used_at IS NULL').run(friendId);
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

// Hash a password.
//
// ⚠ NO TYPE GUARD HERE, AND THAT IS THE DELIBERATE HALF OF FUP-T11's SPLIT.
// `bcrypt.hashSync` throws `Illegal arguments: <type>, number` on a non-string,
// exactly like `compareSync` below — but unlike a comparison there is no
// meaningful "no" to return, so a guard here could only throw or invent a value.
// Both are worse than the alternative: every caller already has a length rule and
// its own Slovak message (and sometimes a `field` marker), so the guard belongs
// AT THE ROUTE, folded into that rule as `typeof password !== 'string' ||
// password.length < N`. A helper that threw a 400-carrying error would answer with
// the global handler's generic `Neplatna poziadavka` instead, silently replacing
// five distinct messages with one — a loosening in everything but status.
// ⚠ EIGHT call sites, not five — and the class is NOT fully closed. Guarded at the
// route: `friends.js` ×3, `onboarding.js`, `admin.js:236` (change-password).
// Safe by construction: `invitations.js` (hashes a server-generated password) and
// `admin.js:94` (the login migration — `verifyAdminPassword` now refuses non-strings
// before it can be reached).
// ⚠ STILL OPEN, deliberately: `admin.js:68` (`POST /admin/setup`). It is the recorded
// latent exception — the "Admin uz je nastaveny" check blocks it on any CONFIGURED
// instance — but on an unconfigured one it really is an unauthenticated 500 with a
// stack (measured: 1266 bytes). Left as scoped in FUP-T11 because an attacker who can
// reach it can simply claim the admin account outright, which is strictly worse than
// a log line. Do not read this comment as "the class is closed"; it is closed
// everywhere an instance is actually configured.
export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

// Compare a plaintext password against a stored hash.
//
// ⚠ THE TYPE GUARD LIVES HERE, INSIDE THE HELPER, ON PURPOSE (FUP-T11).
// `bcrypt.compareSync` THROWS `Illegal arguments: <type>, string` on a non-string,
// so before this guard ANY caller that reached it with a malformed body — an
// object with a `length`, a number, an array, a boolean — turned a client mistake
// into a 500 `Nieco sa pokazilo` PLUS a full stack in the server log. That pattern
// reached EIGHT instances repo-wide precisely because it was fixed call site by
// call site (ML-T6 ×2, FUP-T10 ×1); guarding the helper covers every caller at
// once and is structurally impossible to miss on a ninth.
//
// A comparison can absorb the guard where a hash cannot: a non-string could never
// have matched a bcrypt digest, so `false` is not merely convenient, it is the
// arithmetically correct answer. It routes a malformed body into each caller's
// EXISTING 401 with no new branch, no new message and — the point on the two
// public login routes — NO NEW ORACLE: a malformed password is now indistinguishable
// from a wrong one, and from an account that does not exist.
//
// `hash` is guarded for the same reason: a NULL/absent stored hash reaching here is
// an account with no password, which must refuse, not throw.
export function comparePassword(password, hash) {
  if (typeof password !== 'string' || typeof hash !== 'string') return false;
  return bcrypt.compareSync(password, hash);
}
