import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '../db/schema.js';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Get current auth mode from settings
export function getAuthMode() {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'auth_mode'").get();
  return (setting && setting.value) || 'legacy';
}

// Create a new session token for a friend
export function createFriendSession(friendId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  db.prepare('INSERT INTO friend_sessions (friend_id, token, expires_at) VALUES (?, ?, ?)').run(friendId, token, expiresAt);

  // Opportunistic cleanup of expired sessions
  db.prepare('DELETE FROM friend_sessions WHERE expires_at < ?').run(Date.now());

  return { token, expiresAt };
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
