const express = require('express');
const { customAlphabet } = require('nanoid');
const db = require('../db/init');
const { authMiddleware } = require('../auth');
const { publicUser } = require('./auth');

const router = express.Router();
const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5); // no confusing chars

function roomByCode(code) {
  return db.prepare('SELECT * FROM rooms WHERE code = ?').get(code.toUpperCase());
}

function generateUniqueCode() {
  for (let i = 0; i < 20; i++) {
    const code = nanoid();
    if (!roomByCode(code)) return code;
  }
  throw new Error('could_not_generate_code');
}

function publicRoom(room) {
  return {
    id: room.id,
    code: room.code,
    hostUserId: room.host_user_id,
    mode: room.mode,
    topic: room.topic,
    name: room.name || room.topic,
    language: room.language,
    questionCount: room.question_count,
    maxPlayers: room.max_players || 0, // 0 = no limit
    status: room.status,
    currentQuestionIdx: room.current_question_idx,
  };
}

function activeMemberCount(roomId) {
  return db.prepare('SELECT COUNT(*) c FROM room_members WHERE room_id = ? AND left_at IS NULL').get(roomId).c;
}

// ---------- Create room ----------
router.post('/', authMiddleware, (req, res) => {
  const { mode, topic, name, language, questionCount, maxPlayers } = req.body || {};
  const allowedModes = ['classic', 'blitz'];
  const finalMode = allowedModes.includes(mode) ? mode : 'classic';
  const finalTopic = (topic || 'Общие знания').toString().slice(0, 80);
  const finalName = (name || finalTopic).toString().trim().slice(0, 60) || finalTopic;
  const finalLanguage = (language || 'Русский').toString().slice(0, 30);
  const finalCount = Math.min(30, Math.max(3, parseInt(questionCount, 10) || 10));
  // 0 = no limit, host can pick any cap from 2 to 64
  const parsedMax = parseInt(maxPlayers, 10);
  const finalMaxPlayers = Number.isInteger(parsedMax) && parsedMax > 0 ? Math.min(64, Math.max(2, parsedMax)) : 0;

  const code = generateUniqueCode();
  const info = db
    .prepare(
      `INSERT INTO rooms (code, host_user_id, mode, name, topic, language, question_count, max_players, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lobby')`
    )
    .run(code, req.userId, finalMode, finalName, finalTopic, finalLanguage, finalCount, finalMaxPlayers);
  db.prepare('INSERT INTO room_members (room_id, user_id, is_ready) VALUES (?, ?, 1)').run(
    info.lastInsertRowid,
    req.userId
  );

  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(info.lastInsertRowid);
  res.json({ room: publicRoom(room) });
});

router.patch('/:code', authMiddleware, (req, res) => {
  const room = roomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: 'room_not_found' });
  if (room.host_user_id !== req.userId) return res.status(403).json({ error: 'host_only' });
  if (room.status !== 'lobby') return res.status(409).json({ error: 'room_already_started' });
  const body = req.body || {};
  const updates = [];
  const params = [];

  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'invalid_name' });
    updates.push('name = ?');
    params.push(name);
  }

  if (body.maxPlayers !== undefined) {
    const parsedMax = parseInt(body.maxPlayers, 10);
    const currentCount = activeMemberCount(room.id);
    const finalMaxPlayers = Number.isInteger(parsedMax) && parsedMax > 0 ? Math.min(64, Math.max(2, parsedMax)) : 0;
    if (finalMaxPlayers > 0 && finalMaxPlayers < currentCount) {
      return res.status(400).json({ error: 'max_players_too_low', message: `В комнате уже ${currentCount} игроков.` });
    }
    updates.push('max_players = ?');
    params.push(finalMaxPlayers);
  }

  if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });

  params.push(room.id);
  db.prepare(`UPDATE rooms SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...params);
  res.json({ room: publicRoom(roomByCode(room.code)) });
});

// ---------- Browse open rooms (public lobby list, for the "join a room" screen) ----------
router.get('/', authMiddleware, (req, res) => {
  const rooms = db
    .prepare(
      `SELECT * FROM rooms WHERE status = 'lobby' ORDER BY updated_at DESC LIMIT 40`
    )
    .all();

  const result = rooms.map((room) => {
    const members = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color
         FROM room_members rm JOIN users u ON u.id = rm.user_id
         WHERE rm.room_id = ? AND rm.left_at IS NULL
         ORDER BY rm.joined_at ASC LIMIT 8`
      )
      .all(room.id);
    return {
      ...publicRoom(room),
      memberCount: activeMemberCount(room.id),
      members: members.map((m) => ({
        id: m.id,
        displayName: m.display_name,
        avatarUrl: m.avatar_url,
        avatarEmoji: m.avatar_emoji,
        avatarColor: m.avatar_color,
      })),
    };
  })
  // hide rooms that are already full from the browse list — code-entry still works for them
  .filter((r) => !r.maxPlayers || r.memberCount < r.maxPlayers);

  res.json({ rooms: result });
});

// ---------- Get room by code (for joining / rejoining) ----------
router.get('/:code', authMiddleware, (req, res) => {
  const room = roomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: 'room_not_found' });

  const members = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color, rm.score, rm.is_ready
       FROM room_members rm JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = ? AND rm.left_at IS NULL
       ORDER BY rm.joined_at ASC`
    )
    .all(room.id);

  res.json({
    room: publicRoom(room),
    members: members.map((m) => ({
      id: m.id,
      username: m.username,
      displayName: m.display_name,
      avatarUrl: m.avatar_url,
      avatarEmoji: m.avatar_emoji,
      avatarColor: m.avatar_color,
      score: m.score,
      isReady: !!m.is_ready,
    })),
  });
});

// ---------- Join room (adds membership row; WS handles live presence) ----------
router.post('/:code/join', authMiddleware, (req, res) => {
  const room = roomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: 'room_not_found' });

  const existing = db
    .prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?')
    .get(room.id, req.userId);

  // Someone who is already a member may come back at any time — including mid-game after a
  // page reload. Blocking that (as "room_already_started") locked players out of a game
  // they were still part of, since the room keeps their membership row.
  if (existing) {
    if (existing.left_at) {
      db.prepare('UPDATE room_members SET left_at = NULL WHERE id = ?').run(existing.id);
    }
    return res.json({ room: publicRoom(room) });
  }

  if (room.status !== 'lobby') return res.status(409).json({ error: 'room_already_started' });

  const memberCount = activeMemberCount(room.id);
  if (room.max_players > 0 && memberCount >= room.max_players) {
    return res.status(409).json({ error: 'room_full' });
  }

  db.prepare('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)').run(room.id, req.userId);

  res.json({ room: publicRoom(room) });
});

module.exports = { router, roomByCode, publicRoom };
