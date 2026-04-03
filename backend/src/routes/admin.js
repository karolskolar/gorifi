import { Router } from 'express';
import db from '../db/schema.js';
import crypto from 'crypto';

const router = Router();

// Hash password with SHA-256
const hashPassword = (password) => {
  return crypto.createHash('sha256').update(password).digest('hex');
};

// Check if admin password is set
router.get('/setup-status', (req, res) => {
  const setting = db.prepare("SELECT * FROM settings WHERE key = 'admin_password'").get();
  res.json({ isSetup: !!setting });
});

// Initial setup - set admin password
router.post('/setup', (req, res) => {
  const { password } = req.body;

  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Heslo musi mat aspon 4 znaky' });
  }

  // Check if already set up
  const existing = db.prepare("SELECT * FROM settings WHERE key = 'admin_password'").get();
  if (existing) {
    return res.status(400).json({ error: 'Admin uz je nastaveny' });
  }

  const hashedPassword = hashPassword(password);
  db.prepare("INSERT INTO settings (key, value) VALUES ('admin_password', ?)").run(hashedPassword);

  res.json({ success: true, message: 'Admin heslo bolo nastavene' });
});

// Login
router.post('/login', (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Heslo je povinne' });
  }

  const setting = db.prepare("SELECT * FROM settings WHERE key = 'admin_password'").get();

  if (!setting) {
    return res.status(400).json({ error: 'Admin nie je nastaveny' });
  }

  const hashedPassword = hashPassword(password);

  if (hashedPassword !== setting.value) {
    return res.status(401).json({ error: 'Nespravne heslo' });
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

// Get admin settings (friends_password, etc.)
router.get('/settings', (req, res) => {
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

// Update admin settings
router.put('/settings', (req, res) => {
  const { friendsPassword, paymentIban, paymentRevolutUsername } = req.body;

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

// Change password (requires current password)
router.post('/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Obe hesla su povinne' });
  }

  if (newPassword.length < 4) {
    return res.status(400).json({ error: 'Nove heslo musi mat aspon 4 znaky' });
  }

  const setting = db.prepare("SELECT * FROM settings WHERE key = 'admin_password'").get();

  if (!setting) {
    return res.status(400).json({ error: 'Admin nie je nastaveny' });
  }

  const hashedCurrent = hashPassword(currentPassword);

  if (hashedCurrent !== setting.value) {
    return res.status(401).json({ error: 'Nespravne aktualne heslo' });
  }

  const hashedNew = hashPassword(newPassword);
  db.prepare("UPDATE settings SET value = ? WHERE key = 'admin_password'").run(hashedNew);

  // Invalidate token
  db.prepare("DELETE FROM settings WHERE key = 'admin_token'").run();

  res.json({ success: true, message: 'Heslo bolo zmenene' });
});

export default router;
