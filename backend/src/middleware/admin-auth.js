import db from '../db/schema.js';

// Validate the admin session token stored in the settings table.
// The token is issued at POST /api/admin/login and stored under the
// 'admin_token' key as JSON { token, expiry }. This mirrors the logic in
// admin.js's /verify route so both share one source of truth.
function isValidAdminToken(token) {
  if (!token) return false;

  const setting = db.prepare("SELECT value FROM settings WHERE key = 'admin_token'").get();
  if (!setting) return false;

  try {
    const { token: storedToken, expiry } = JSON.parse(setting.value);
    return token === storedToken && Date.now() < expiry;
  } catch (e) {
    // Malformed stored token
    return false;
  }
}

// Express middleware: reject any request that does not carry a valid admin
// token in the X-Admin-Token header. Apply to every privileged route.
export function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'Neautorizovaný prístup' });
  }
  next();
}

export { isValidAdminToken };
