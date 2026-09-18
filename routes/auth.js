const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db/init');
const { signToken, authMiddleware } = require('../auth');
const { rateLimit } = require('../rateLimit');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

// Login/register are the endpoints worth throttling — everything else requires
// a valid token already, so a stolen/guessed credential is the actual risk here.
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Слишком много попыток входа. Подождите пару минут и попробуйте снова.',
});

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarUrl: u.avatar_url || null,
    avatarEmoji: u.avatar_emoji,
    avatarColor: u.avatar_color,
  };
}

// ---------- Register ----------
router.post('/register', authLimiter, (req, res) => {
  const { username, password, displayName } = req.body || {};

  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'invalid_username', message: 'Имя пользователя: 3-20 символов, латиница/цифры/подчёркивание.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'invalid_password', message: 'Пароль минимум 6 символов.' });
  }
  const name = (displayName || username).toString().trim().slice(0, 40) || username;

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'username_taken', message: 'Это имя пользователя уже занято.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)'
  ).run(username, hash, name);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// ---------- Login ----------
router.post('/login', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Неверное имя пользователя или пароль.' });
  }
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// ---------- Current user ----------
router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json({ user: publicUser(user) });
});

// ---------- Update profile (name / emoji / color) ----------
router.patch('/me', authMiddleware, (req, res) => {
  const { displayName, avatarEmoji, avatarColor } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'not_found' });

  const nextName = displayName !== undefined ? String(displayName).trim().slice(0, 40) || user.display_name : user.display_name;
  const nextEmoji = avatarEmoji !== undefined ? String(avatarEmoji).slice(0, 8) : user.avatar_emoji;
  const nextColor = avatarColor !== undefined && /^#[0-9a-fA-F]{6}$/.test(avatarColor) ? avatarColor : user.avatar_color;

  db.prepare(
    'UPDATE users SET display_name = ?, avatar_emoji = ?, avatar_color = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).run(nextName, nextEmoji, nextColor, req.userId);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: publicUser(updated) });
});

// ---------- Avatar upload ----------
const avatarsDir = path.join(__dirname, '..', 'uploads', 'avatars');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarsDir),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
    cb(null, `u${req.userId}_${crypto.randomBytes(6).toString('hex')}${safeExt}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('bad_file_type'), ok);
  },
});

router.post('/me/avatar', authMiddleware, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  // clean up previous uploaded avatar file if it exists on disk
  if (user.avatar_url) {
    const oldPath = path.join(__dirname, '..', 'uploads', 'avatars', path.basename(user.avatar_url));
    fs.unlink(oldPath, () => {});
  }

  const publicPath = `/uploads/avatars/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar_url = ?, updated_at = datetime(\'now\') WHERE id = ?').run(publicPath, req.userId);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: publicUser(updated) });
});

router.delete('/me/avatar', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (user.avatar_url) {
    const oldPath = path.join(__dirname, '..', 'uploads', 'avatars', path.basename(user.avatar_url));
    fs.unlink(oldPath, () => {});
  }
  db.prepare('UPDATE users SET avatar_url = NULL, updated_at = datetime(\'now\') WHERE id = ?').run(req.userId);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: publicUser(updated) });
});

// ---------- Change password ----------
router.post('/me/password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'invalid_password' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!bcrypt.compareSync(currentPassword || '', user.password_hash)) {
    return res.status(401).json({ error: 'wrong_password' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hash, req.userId);
  res.json({ ok: true });
});

module.exports = { router, publicUser };
