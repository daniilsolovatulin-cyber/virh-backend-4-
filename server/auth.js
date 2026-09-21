const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db/init');

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error(
    'JWT_SECRET is not set. Refusing to start in production with the default secret — ' +
    'anyone who knows it could forge login tokens. Set JWT_SECRET in server/.env.'
  );
}
// Never fall back to a hardcoded constant — it would let anyone forge login tokens.
// Without JWT_SECRET we generate a random one for this process; sessions simply do not
// survive a restart, and the client handles that by asking to log in again.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn(
    '⚠️  JWT_SECRET не задан — сгенерирован случайный ключ на этот запуск. ' +
    'После перезапуска все сессии станут недействительны. Задайте JWT_SECRET в server/.env.'
  );
}
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
