const { WebSocketServer } = require('ws');
const db = require('./db/init');
const { verifyToken } = require('./auth');
const { generateQuestions } = require('./questionGen');

// roomId -> Set of { ws, userId }
const roomSockets = new Map();
// roomId -> timer that ends the current question
const roomTimers = new Map();
const roomDeadlines = new Map();

// Classic gives a full 20s per question; blitz is faster so one slow player can't stall the room.
const QUESTION_SECONDS = { classic: 20, blitz: 10 };
function questionDurationMs(room) {
  return (QUESTION_SECONDS[room && room.mode] || QUESTION_SECONDS.classic) * 1000;
}

// questions_json is written by this module, but a corrupt value must never take the
// process down inside a socket callback — so parsing is always guarded.
function parseQuestions(room) {
  try {
    const parsed = JSON.parse(room.questions_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('Не удалось разобрать questions_json комнаты', room && room.id, e.message);
    return [];
  }
}

function publicMember(m) {
  return {
    id: m.id,
    username: m.username,
    displayName: m.display_name,
    avatarUrl: m.avatar_url,
    avatarEmoji: m.avatar_emoji,
    avatarColor: m.avatar_color,
    score: m.score,
    isReady: !!m.is_ready,
  };
}

function getMembers(roomId) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color, rm.score, rm.is_ready
       FROM room_members rm JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = ? AND rm.left_at IS NULL
       ORDER BY rm.joined_at ASC`
    )
    .all(roomId)
    .map(publicMember);
}

function broadcast(roomId, payload) {
  const sockets = roomSockets.get(roomId);
  if (!sockets) return;
  const msg = JSON.stringify(payload);
  for (const client of sockets) {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(msg);
  }
}

function sendTo(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastLobby(roomId) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  broadcast(roomId, { type: 'lobby_update', members: getMembers(roomId), room: room ? {
    name: room.name || room.topic,
    hostUserId: room.host_user_id,
    maxPlayers: room.max_players || 0,
  } : null });
}

function safeQuestionForClient(q) {
  // strip the correct-answer index so clients can't peek before submitting
  return { question: q.question, options: q.options };
}

async function startGame(roomId) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room || room.status !== 'lobby') return;

  db.prepare("UPDATE rooms SET status = 'generating' WHERE id = ?").run(roomId);
  broadcast(roomId, { type: 'status', status: 'generating' });

  let questions;
  try {
    questions = await generateQuestions(room.topic, room.language, room.question_count, room.age_group);
  } catch (e) {
    questions = [];
  }

  if (!questions.length) {
    db.prepare("UPDATE rooms SET status = 'lobby' WHERE id = ?").run(roomId);
    broadcast(roomId, { type: 'error', message: 'Не удалось сгенерировать вопросы. Попробуйте ещё раз.' });
    broadcast(roomId, { type: 'status', status: 'lobby' });
    return;
  }

  db.prepare(
    "UPDATE rooms SET status = 'playing', questions_json = ?, current_question_idx = 0, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(questions), roomId);

  pushQuestion(roomId, 0);
}

function pushQuestion(roomId, idx) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) return;
  const questions = parseQuestions(room);
  if (idx >= questions.length) {
    finishGame(roomId);
    return;
  }

  db.prepare("UPDATE rooms SET current_question_idx = ?, updated_at = datetime('now') WHERE id = ?").run(idx, roomId);

  const duration = questionDurationMs(room);
  const deadline = Date.now() + duration;
  roomDeadlines.set(roomId, deadline);
  broadcast(roomId, {
    type: 'question',
    index: idx,
    total: questions.length,
    deadline,
    question: safeQuestionForClient(questions[idx]),
  });

  const timer = roomTimers.get(roomId);
  if (timer) clearTimeout(timer);
  // auto-advance once everyone has answered or the question time runs out
  const t = setTimeout(() => revealAndAdvance(roomId, idx), duration);
  roomTimers.set(roomId, t);
}

function allMembersAnswered(roomId, idx) {
  const memberCount = db
    .prepare('SELECT COUNT(*) c FROM room_members WHERE room_id = ? AND left_at IS NULL')
    .get(roomId).c;
  const answerCount = db
    .prepare(
      `SELECT COUNT(*) c
       FROM room_answers ra
       JOIN room_members rm ON rm.room_id = ra.room_id AND rm.user_id = ra.user_id
       WHERE ra.room_id = ? AND ra.question_idx = ? AND rm.left_at IS NULL`
    )
    .get(roomId, idx).c;
  return memberCount > 0 && answerCount >= memberCount;
}

function revealAndAdvance(roomId, idx) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room || room.status !== 'playing' || room.current_question_idx !== idx) return;

  const questions = parseQuestions(room);
  const q = questions[idx];
  if (!q) {
    // Nothing left to reveal (corrupt or cleared question set) — end the game instead of hanging.
    finishGame(roomId);
    return;
  }

  const answers = db
    .prepare(
      `SELECT ra.user_id, ra.option_idx, ra.is_correct, u.display_name
       FROM room_answers ra JOIN users u ON u.id = ra.user_id
       WHERE ra.room_id = ? AND ra.question_idx = ?`
    )
    .all(roomId, idx);

  broadcast(roomId, {
    type: 'reveal',
    index: idx,
    correct: q.correct,
    answers: answers.map((a) => ({ userId: a.user_id, displayName: a.display_name, optionIdx: a.option_idx, isCorrect: !!a.is_correct })),
    scores: getMembers(roomId).map((m) => ({ userId: m.id, score: m.score })),
  });

  setTimeout(() => pushQuestion(roomId, idx + 1), 2800);
}

function finishGame(roomId) {
  db.prepare("UPDATE rooms SET status = 'finished', updated_at = datetime('now') WHERE id = ?").run(roomId);
  const timer = roomTimers.get(roomId);
  if (timer) clearTimeout(timer);
  roomTimers.delete(roomId);
  roomDeadlines.delete(roomId);

  const members = getMembers(roomId).sort((a, b) => b.score - a.score);
  broadcast(roomId, { type: 'game_over', leaderboard: members });
}

function submitAnswer(roomId, userId, questionIdx, optionIdx) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room || room.status !== 'playing' || room.current_question_idx !== questionIdx) return;
  const member = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? AND left_at IS NULL').get(roomId, userId);
  if (!member) return;

  // Reject answers that arrive after the question deadline (small tolerance for network lag).
  const deadline = roomDeadlines.get(roomId);
  if (deadline && Date.now() > deadline + 750) return;

  const questions = parseQuestions(room);
  const q = questions[questionIdx];
  if (!q) return;
  if (optionIdx < 0 || optionIdx >= q.options.length) return;

  const isCorrect = optionIdx === q.correct ? 1 : 0;

  try {
    db.prepare(
      'INSERT INTO room_answers (room_id, user_id, question_idx, option_idx, is_correct) VALUES (?, ?, ?, ?, ?)'
    ).run(roomId, userId, questionIdx, optionIdx, isCorrect);
  } catch (e) {
    return; // already answered this question — ignore duplicate submit
  }

  if (isCorrect) {
    db.prepare("UPDATE room_members SET score = score + 100 WHERE room_id = ? AND user_id = ?").run(roomId, userId);
  }

  broadcast(roomId, { type: 'player_answered', userId, questionIdx });

  if (allMembersAnswered(roomId, questionIdx)) {
    const timer = roomTimers.get(roomId);
    if (timer) clearTimeout(timer);
    revealAndAdvance(roomId, questionIdx);
  }
}

function attachSocket(roomId, ws, userId) {
  if (!roomSockets.has(roomId)) roomSockets.set(roomId, new Set());
  const entry = { ws, userId };
  roomSockets.get(roomId).add(entry);
  return entry;
}

function detachSocket(roomId, entry) {
  const set = roomSockets.get(roomId);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) roomSockets.delete(roomId);
}

function markLeft(roomId, userId) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  const member = db.prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ? AND left_at IS NULL').get(roomId, userId);
  if (!room || !member) return;

  db.prepare("UPDATE room_members SET left_at = datetime('now') WHERE room_id = ? AND user_id = ?").run(roomId, userId);

  // Keep a lobby playable when its host leaves: hand ownership to the oldest active player.
  if (room.host_user_id === userId) {
    const nextHost = db.prepare(
      "SELECT user_id FROM room_members WHERE room_id = ? AND left_at IS NULL ORDER BY joined_at ASC LIMIT 1"
    ).get(roomId);
    if (nextHost) {
      db.prepare("UPDATE rooms SET host_user_id = ?, updated_at = datetime('now') WHERE id = ?").run(nextHost.user_id, roomId);
    }
  }

  const activeCount = db.prepare('SELECT COUNT(*) c FROM room_members WHERE room_id = ? AND left_at IS NULL').get(roomId).c;
  if (activeCount === 0) {
    const timer = roomTimers.get(roomId);
    if (timer) clearTimeout(timer);
    roomTimers.delete(roomId);
    roomDeadlines.delete(roomId);
    db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
    roomSockets.delete(roomId);
    return;
  }

  broadcastLobby(roomId);

  // Do not wait for a disconnected player who had already answered.
  const fresh = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (fresh && fresh.status === 'playing' && allMembersAnswered(roomId, fresh.current_question_idx)) {
    const timer = roomTimers.get(roomId);
    if (timer) clearTimeout(timer);
    roomTimers.delete(roomId);
    revealAndAdvance(roomId, fresh.current_question_idx);
  }
}

function initRealtime(server) {
  const wss = new WebSocketServer({ noServer: true });

  // Liveness: a half-open TCP connection never fires 'close', which would leave the player
  // counted as "still in the room" forever and stall the game for everyone else.
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    }
  }, 30000);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  server.on('upgrade', (req, socket, head) => {
    // WHATWG URL instead of the deprecated url.parse (kept behaviour-identical).
    let parsed;
    try {
      parsed = new URL(req.url, 'http://localhost');
    } catch (e) {
      socket.destroy();
      return;
    }
    if (parsed.pathname !== '/ws/room') {
      socket.destroy();
      return;
    }
    const query = Object.fromEntries(parsed.searchParams);
    const payload = verifyToken(query.token || '');
    if (!payload) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, { userId: payload.uid, roomCode: (query.code || '').toUpperCase() });
    });
  });

  wss.on('connection', (ws, req, ctx) => {
    const room = db.prepare('SELECT * FROM rooms WHERE code = ?').get(ctx.roomCode);
    if (!room) {
      sendTo(ws, { type: 'error', message: 'room_not_found' });
      ws.close();
      return;
    }
    const member = db.prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, ctx.userId);
    if (!member) {
      sendTo(ws, { type: 'error', message: 'not_a_member' });
      ws.close();
      return;
    }
    if (member.left_at) {
      db.prepare('UPDATE room_members SET left_at = NULL WHERE id = ?').run(member.id);
    }

    const entry = attachSocket(room.id, ws, ctx.userId);

    // sync current state to the joining client
    sendTo(ws, { type: 'lobby_update', members: getMembers(room.id) });
    sendTo(ws, { type: 'status', status: room.status });
    if (room.status === 'playing') {
      const questions = JSON.parse(room.questions_json || '[]');
      const idx = room.current_question_idx;
      if (questions[idx]) {
        sendTo(ws, { type: 'question', index: idx, total: questions.length, deadline: roomDeadlines.get(room.id) || (Date.now() + 20000), question: safeQuestionForClient(questions[idx]) });
      }
    }
    broadcastLobby(room.id);

    // A malformed frame makes ws emit 'error' on this socket. Without a listener that
    // becomes an unhandled 'error' event and brings the whole server process down.
    ws.on('error', (err) => {
      console.warn('WebSocket error:', err && err.message);
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }

      if (msg.type === 'ready_toggle') {
        db.prepare("UPDATE room_members SET is_ready = 1 - is_ready WHERE room_id = ? AND user_id = ?").run(room.id, ctx.userId);
        broadcastLobby(room.id);
      }

      if (msg.type === 'start_game') {
        const fresh = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
        if (fresh.host_user_id === ctx.userId && fresh.status === 'lobby') {
          startGame(room.id);
        }
      }

      if (msg.type === 'rename_room') {
        const fresh = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
        const name = String(msg.name || '').trim().slice(0, 60);
        if (fresh.host_user_id === ctx.userId && fresh.status === 'lobby' && name) {
          db.prepare("UPDATE rooms SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, room.id);
          broadcastLobby(room.id);
        }
      }

      if (msg.type === 'set_max_players') {
        const fresh = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
        if (fresh.host_user_id === ctx.userId && fresh.status === 'lobby') {
          const parsed = parseInt(msg.maxPlayers, 10);
          const currentCount = getMembers(room.id).length;
          const nextMax = Number.isInteger(parsed) && parsed > 0 ? Math.min(64, Math.max(2, parsed)) : 0;
          if (nextMax === 0 || nextMax >= currentCount) {
            db.prepare("UPDATE rooms SET max_players = ?, updated_at = datetime('now') WHERE id = ?").run(nextMax, room.id);
            broadcastLobby(room.id);
          }
        }
      }

      if (msg.type === 'leave_room') {
        markLeft(room.id, ctx.userId);
        sendTo(ws, { type: 'left_room' });
        ws.close();
        return;
      }

      if (msg.type === 'submit_answer') {
        const optionIdx = parseInt(msg.optionIdx, 10);
        const questionIdx = parseInt(msg.questionIdx, 10);
        if (Number.isInteger(optionIdx) && Number.isInteger(questionIdx)) {
          submitAnswer(room.id, ctx.userId, questionIdx, optionIdx);
        }
      }

      if (msg.type === 'play_again') {
        const fresh = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
        if (fresh.host_user_id === ctx.userId && fresh.status === 'finished') {
          db.prepare("UPDATE rooms SET status = 'lobby', current_question_idx = 0, questions_json = NULL WHERE id = ?").run(room.id);
          db.prepare('UPDATE room_members SET score = 0, is_ready = 0 WHERE room_id = ?').run(room.id);
          db.prepare('DELETE FROM room_answers WHERE room_id = ?').run(room.id);
          broadcast(room.id, { type: 'status', status: 'lobby' });
          broadcastLobby(room.id);
        }
      }
    });

    ws.on('close', () => {
      detachSocket(room.id, entry);
      // grace period: only mark as left if they don't reconnect quickly
      setTimeout(() => {
        const stillConnected = [...(roomSockets.get(room.id) || [])].some((e) => e.userId === ctx.userId);
        if (!stillConnected) markLeft(room.id, ctx.userId);
      }, 5000);
    });
  });

  return wss;
}

module.exports = { initRealtime };
