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
app.use('/api/solo', soloRouter);
app.use('/api/rooms', roomsRouter);

// Serve the local beta frontend from the same origin as the API.
// This makes http://localhost:3001 the single entry point for local testing.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  if (err && err.message === 'bad_file_type') {
    return res.status(400).json({ error: 'bad_file_type', message: 'Разрешены только изображения (jpg, png, webp, gif).' });
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
