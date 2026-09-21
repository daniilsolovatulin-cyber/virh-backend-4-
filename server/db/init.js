const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_SECRET_KEY || '';
const snapshotPath = path.join(__dirname, 'vihr.sqlite');

function restoreSnapshot() {
  if (!SUPA_URL || !SUPA_KEY) {
    console.warn('Supabase snapshot restore skipped: missing environment variables');
    return false;
  }
  try {
    // A base64 SQLite snapshot is larger than Node's 1 MB default output
    // buffer. Give curl enough room so a valid snapshot is restored instead
    // of silently starting the free instance with an empty local database.
    const out = cp.execFileSync(
      'curl',
      ['-sS', '--max-time', '30', SUPA_URL + '/rest/v1/vihr_state?id=eq.1&select=payload', '-H', 'apikey: ' + SUPA_KEY, '-H', 'Authorization: Bearer ' + SUPA_KEY],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    const rows = JSON.parse(out || '[]');
    if (!rows[0] || !rows[0].payload) {
      console.warn('Supabase snapshot restore skipped: no snapshot row found');
      return true;
    }
    const snapshot = Buffer.from(rows[0].payload, 'base64');
    if (snapshot.subarray(0, 15).toString() !== 'SQLite format 3') throw new Error('invalid SQLite snapshot');
    fs.writeFileSync(snapshotPath, snapshot);
    for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(snapshotPath + suffix); } catch (e) {} }
    console.log('Supabase snapshot restored (' + snapshot.length + ' bytes)');
    return true;
  } catch (e) {
    console.warn('Supabase snapshot restore skipped:', e.message);
    return false;
  }
}
const snapshotRestored = restoreSnapshot();
const snapshotPersistenceReady = !SUPA_URL || !SUPA_KEY || snapshotRestored;

const DB_PATH = snapshotPath;
const db = new Database(DB_PATH);

let persistTimer;
let persistChain = Promise.resolve();
async function persistSnapshot() {
  if (!snapshotPersistenceReady || !SUPA_URL || !SUPA_KEY) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    const payload = fs.readFileSync(DB_PATH).toString('base64');
    const response = await fetch(SUPA_URL + '/rest/v1/vihr_state', {
      method: 'POST',
      headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ id: 1, payload, updated_at: new Date().toISOString() }),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    console.log('Supabase snapshot saved (' + payload.length + ' base64 chars)');
  } catch (e) { console.warn('Supabase snapshot save failed:', e.message); }
}
function schedulePersist() {
  if (!snapshotPersistenceReady || !SUPA_URL || !SUPA_KEY) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistChain = persistChain.then(persistSnapshot); }, 250);
}
async function flushSnapshot() {
  clearTimeout(persistTimer);
  persistChain = persistChain.then(persistSnapshot);
  await persistChain;
}
const rawPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const stmt = rawPrepare(sql);
  return new Proxy(stmt, {
    get(target, prop) {
      if (prop === 'run') return (...args) => {
        const result = target.run(...args);
        schedulePersist();
        return result;
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

process.once('SIGTERM', async () => { await flushSnapshot(); process.exit(0); });
process.once('SIGINT', async () => { await flushSnapshot(); process.exit(0); });

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  avatar_emoji TEXT DEFAULT '🙂',
  avatar_color TEXT DEFAULT '#7C6FE8',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  host_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'classic',
  name TEXT,
  topic TEXT,
  language TEXT NOT NULL DEFAULT 'Русский',
  question_count INTEGER NOT NULL DEFAULT 10,
  max_players INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'lobby',
  current_question_idx INTEGER NOT NULL DEFAULT 0,
  questions_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS room_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 0,
  is_ready INTEGER NOT NULL DEFAULT 0,
  team TEXT,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  left_at TEXT,
  UNIQUE(room_id, user_id)
);
CREATE TABLE IF NOT EXISTS room_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  team TEXT,
  scope TEXT NOT NULL DEFAULT 'lobby',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, created_at);
CREATE TABLE IF NOT EXISTS room_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_idx INTEGER NOT NULL,
  option_idx INTEGER NOT NULL,
  is_correct INTEGER NOT NULL,
  answered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(room_id, user_id, question_idx)
);
CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_room_answers_room_q ON room_answers(room_id, question_idx);
`);
try { db.exec("ALTER TABLE rooms ADD COLUMN name TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE rooms ADD COLUMN max_players INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE rooms ADD COLUMN password_hash TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE rooms ADD COLUMN question_seconds INTEGER NOT NULL DEFAULT 20"); } catch (e) {}
try { db.exec("ALTER TABLE rooms ADD COLUMN team_mode INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE room_members ADD COLUMN team TEXT"); } catch (e) {}
db.exec("UPDATE rooms SET name = topic WHERE name IS NULL OR name = ''");
const avatarsDir = path.join(__dirname, '..', 'uploads', 'avatars');
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });
module.exports = db;
