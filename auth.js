const jwt = require('jsonwebtoken');
const db = require('./db/init');

const FALLBACK_SECRET = 'dev_secret_change_me';
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error(
    'JWT_SECRET is not set. Refusing to start in production with the default secret — ' +
    'anyone who knows it could forge login tokens. Set JWT_SECRET in server/.env.'
  );
}
const JWT_SECRET = process.env.JWT_SECRET || FALLBACK_SECRET;
const TOKEN_TTL = '30d';

function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'invalid_token' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(payload.uid);
  if (!user) return res.status(401).json({ error: 'stale_session', message: 'Сессия устарела. Войдите заново.' });
  req.userId = payload.uid;
  req.username = payload.username;
  next();
}

module.exports = { signToken, verifyToken, authMiddleware, JWT_SECRET };
