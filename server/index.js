require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');

const { router: authRouter } = require('./routes/auth');
const { router: roomsRouter } = require('./routes/rooms');
const { router: soloRouter } = require('./routes/solo');
const { initRealtime } = require('./realtime');
const { hasServerKeys } = require('./questionGen');

const app = express();
const PORT = process.env.PORT || 3001;

// Needed on Render (and any platform behind a reverse proxy) so req.ip reflects
// the real client address instead of the proxy's — the auth rate limiter keys on it.
app.set('trust proxy', 1);

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, groqConfigured: hasServerKeys() });
});

app.use('/api/auth', authRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/solo', soloRouter);

// Unknown /api/* route: answer with JSON instead of falling through to the static files.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Такого эндпоинта нет.' });
});

// Serve the local beta frontend from the same origin as the API.
// This makes http://localhost:3001 the single entry point for local testing.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  if (err && err.message === 'bad_file_type') {
    return res.status(400).json({ error: 'bad_file_type', message: 'Разрешены только изображения (jpg, png, webp, gif).' });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large', message: 'Файл больше 4 МБ.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', message: 'Слишком большой запрос.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_json', message: 'Некорректный JSON в запросе.' });
  }
  // Middleware errors (body-parser, multer) already carry a client status — turning them
  // into a 500 hides the real cause from the client.
  const status = err && (err.status || err.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ error: err.code || 'bad_request', message: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

const server = http.createServer(app);
initRealtime(server);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Vihr server running on http://localhost:${PORT}`);
  if (!hasServerKeys()) {
    console.warn('⚠️  GROQ_API_KEYS not set — question generation will fail. Add keys to server/.env');
  }
});
