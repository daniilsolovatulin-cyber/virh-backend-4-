const { WebSocketServer } = require('ws');
const url = require('url');
const db = require('./db/init');
const { verifyToken } = require('./auth');
const { generateQuestions } = require('./questionGen');
const { roomApiKeys } = require('./routes/rooms');

// roomId -> Set of { ws, userId }
const roomSockets = new Map();
// roomId -> per-question answer deadline timer (blitz uses one global timer instead)
const roomTimers = new Map();
const roomDeadlines = new Map();

const TEAM_NAMES = { A: 'Команда А', B: 'Команда Б', C: 'Команда В', D: 'Команда Г' };
const TEAM_COLORS = { A: '#3D3AF1', B: '#E8536F', C: '#22B37A', D: '#E8A33D' };

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
    team: m.team || null,
  };
}

function getMembers(roomId) {
  return db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color, rm.score, rm.is_ready, rm.team
       FROM room_members rm JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = ? AND rm.left_at IS NULL
       ORDER BY rm.joined_at ASC`
    )
    .all(roomId)
    .map(publicMember);
}

function getTeamStandings(roomId) {
  const members = getMembers(roomId);
  const teams = new Map();
  for (const m of members) {
    const key = m.team || null;
    if (!key) continue;
    if (!teams.has(key)) teams.set(key, { team: key, name: TEAM_NAMES[key] || key, color: TEAM_COLORS[key] || '#888', score: 0, members: [] });
    const t = teams.get(key);
    t.score += m.score;
    t.members.push({ id: m.id, displayName: m.displayName, score: m.score, avatarUrl: m.avatarUrl, avatarEmoji: m.avatarEmoji, avatarColor: m.avatarColor });
  }
  return [...teams.values()].sort((a, b) => b.score - a.score);
}

// Per-player answer stats across the whole game so far: total answered, correct count,
// current streak, best streak, and fastest correct answer time (ms from question start).
function getPlayerStats(roomId, userId) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  const rows = db
    .prepare('SELECT question_idx, is_correct FROM room_answers WHERE room_id = ? AND user_id = ? ORDER BY question_idx ASC')
    .all(roomId, userId);
  const totalAnswered = rows.length;
  const correct = rows.filter((r) => r.is_correct).length;
  let streak = 0, bestStreak = 0;
  for (const r of rows) {
    if (r.is_correct) { streak += 1; bestStreak = Math.max(bestStreak, streak); }
    else streak = 0;
  }
  const member = db.prepare(
    `SELECT u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color, rm.score, rm.team
     FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = ? AND rm.user_id = ?`
  ).get(roomId, userId);
  return {
    userId,
    displayName: member ? member.display_name : null,
    avatarUrl: member ? member.avatar_url : null,
    avatarEmoji: member ? member.avatar_emoji : null,
    avatarColor: member ? member.avatar_color : null,
    team: member ? member.team : null,
    score: member ? member.score : 0,
    totalAnswered,
    totalQuestions: room ? JSON.parse(room.questions_json || '[]').length : 0,
    correct,
    accuracy: totalAnswered ? Math.round((correct / totalAnswered) * 100) : 0,
    currentStreak: streak,
    bestStreak,
  };
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
    questionSeconds: room.question_seconds || 20,
    teamMode: !!room.team_mode,
  } : null, teamStandings: room && room.team_mode ? getTeamStandings(roomId) : null });
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
    questions = await generateQuestions(
      room.topic,
      room.language,
      room.question_count,
      room.age_group,
      roomApiKeys.get(room.id) || '',
      (evt) => broadcast(roomId, { type: 'gen_progress', ...evt }),
      true
    );
  } catch (e) {
    questions = [];
  }

  if (!questions.length) {
    db.prepare("UPDATE rooms SET status = 'lobby' WHERE id = ?").run(roomId);
    broadcast(roomId, { type: 'error', message: 'Не удалось сгенерировать вопросы. Попробуйте ещё раз.' });
    broadcast(roomId, { type: 'status', status: 'lobby' });
    return;
  }
  // A short batch (fact-check trimmed hard on a tough topic) still beats a
  // full room failure — start with what actually passed rather than making
  // everyone wait through another generation cycle.

  db.prepare(
    "UPDATE rooms SET status = 'playing', questions_json = ?, current_question_idx = 0, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(questions), roomId);

  pushQuestion(roomId, 0);
}

function pushQuestion(roomId, idx) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) return;
  const questions = JSON.parse(room.questions_json || '[]');
  if (idx >= questions.length) {
    finishGame(roomId);
    return;
  }

  db.prepare("UPDATE rooms SET current_question_idx = ?, updated_at = datetime('now') WHERE id = ?").run(idx, roomId);

  const roundMs = (room.question_seconds || 20) * 1000;
  const deadline = Date.now() + roundMs;
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
  // Per-question time budget for classic mode, host-configurable — then auto-advance
  // once everyone has answered or time runs out.
  const t = setTimeout(() => revealAndAdvance(roomId, idx), roundMs);
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

  const questions = JSON.parse(room.questions_json || '[]');
  const q = questions[idx];

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
    teamStandings: room.team_mode ? getTeamStandings(roomId) : null,
  });

  setTimeout(() => pushQuestion(roomId, idx + 1), 2800);
}

function finishGame(roomId) {
  db.prepare("UPDATE rooms SET status = 'finished', updated_at = datetime('now') WHERE id = ?").run(roomId);
  const timer = roomTimers.get(roomId);
  if (timer) clearTimeout(timer);
  roomTimers.delete(roomId);
  roomDeadlines.delete(roomId);

  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  const members = getMembers(roomId).sort((a, b) => b.score - a.score);
  const teamStandings = room && room.team_mode ? getTeamStandings(roomId) : null;
  broadcast(roomId, {
    type: 'game_over',
    leaderboard: members,
    teamStandings,
    playerStats: members.map((m) => getPlayerStats(roomId, m.id)),
  });
}

function submitAnswer(roomId, userId, questionIdx, optionIdx) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room || room.status !== 'playing' || room.current_question_idx !== questionIdx) return;
  const member = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? AND left_at IS NULL').get(roomId, userId);
  if (!member) return;

  const questions = JSON.parse(room.questions_json || '[]');
  const q = questions[questionIdx];
  if (!q) return;

  const isCorrect = optionIdx === q.correct ? 1 : 0;

  try {
    db.prepare(
      'INSERT INTO room_answers (room_id, user_id, question_idx, option_idx, is_correct) VALUES (?, ?, ?, ?, ?)'
    ).run(roomId, userId, questionIdx, optionIdx, isCorrect);
  } catch (e) {
    return; // already answered this question — ignore duplicate submit
  }

  let points = 0;
  if (isCorrect) {
    // Kahoot-style speed bonus: full 1000 pts right away, decaying down to a 500 pt floor
    // as the round's time budget runs out, so being fast (not just right) matters.
    const deadline = roomDeadlines.get(roomId);
    const roundMs = (room.question_seconds || 20) * 1000;
    let speedFactor = 1;
    if (deadline) {
      const remainingMs = Math.max(0, deadline - Date.now());
      speedFactor = Math.min(1, remainingMs / roundMs);
    }
    const base = 500 + Math.round(500 * speedFactor);
    // Streak bonus: consecutive correct answers earn a small escalating multiplier.
    const priorRows = db.prepare('SELECT is_correct FROM room_answers WHERE room_id = ? AND user_id = ? AND question_idx < ? ORDER BY question_idx DESC').all(roomId, userId, questionIdx);
    let streak = 0;
    for (const r of priorRows) { if (r.is_correct) streak += 1; else break; }
    const streakBonus = Math.min(streak, 5) * 20;
    points = base + streakBonus;
    db.prepare("UPDATE room_members SET score = score + ? WHERE room_id = ? AND user_id = ?").run(points, roomId, userId);
  }

  broadcast(roomId, { type: 'player_answered', userId, questionIdx, points });

  if (allMembersAnswered(roomId, questionIdx)) {
    const timer = roomTimers.get(roomId);
    if (timer) clearTimeout(timer);
    revealAndAdvance(roomId, questionIdx);
  }
}

function attachSocket(roomId, ws, userId) {
  if (!roomSockets.has(roomId)) roomSockets.set(roomId, new Set());
  const set = roomSockets.get(roomId);
  // A reconnect (client-side WS drop/retry) can open a new socket before the
  // server has noticed the old one died — if both stay registered, every
  // broadcast (chat messages, lobby updates, everything) gets delivered to
  // this user twice. Close and drop any existing socket for this user in
  // this room before registering the new one, so there's ever only one.
  for (const existing of set) {
    if (existing.userId === userId) {
      set.delete(existing);
      try { existing.ws.close(); } catch (e) {}
    }
  }
  const entry = { ws, userId };
  set.add(entry);
  return entry;
}

// Render (and most mobile carriers/NAT) silently kill an idle WebSocket after
// roughly 55-100s of no traffic — no close frame, no error, the pipe just
// stops. Without a heartbeat the *client* only finds out once it tries to
// send something and the OS finally reports the drop, which the client reads
// as a real disconnect (see connectRoomSocket in app.js). Pinging periodically
// keeps the connection classified as active on both ends, and detects the
// small number of genuinely dead sockets so they can be cleaned up promptly
// instead of leaking in roomSockets until someone tries to broadcast to them.
const HEARTBEAT_INTERVAL_MS = 25000;

function startHeartbeat(wss) {
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch (e) {}
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  }, HEARTBEAT_INTERVAL_MS);
  wss.on('close', () => clearInterval(interval));
  return interval;
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
    roomApiKeys.delete(roomId);
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
  // A restart cannot resume an in-flight model request.
  db.prepare("UPDATE rooms SET status = 'lobby', updated_at = datetime('now') WHERE status = 'generating'").run();
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    if (pathname !== '/ws/room') {
      socket.destroy();
      return;
    }
    const payload = verifyToken(query.token || '');
    if (!payload) {
      socket.destroy();
      return;
    }
    // Same reset-safety check as authMiddleware: a token whose username/created_at
    // no longer matches the account currently at that id belongs to a database
    // that was rebuilt since it was issued — reject it instead of connecting
    // as whoever now holds that id.
    const user = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(payload.uid);
    if (!user || user.username !== payload.username || user.created_at !== payload.createdAt) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, { userId: payload.uid, roomCode: (query.code || '').toUpperCase() });
    });
  });

  startHeartbeat(wss);

  wss.on('connection', (ws, req, ctx) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

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
    sendTo(ws, { type: 'lobby_update', members: getMembers(room.id), teamStandings: room.team_mode ? getTeamStandings(room.id) : null });
    sendTo(ws, { type: 'status', status: room.status });

    // Replay recent chat history the joining player is allowed to see: lobby-wide messages,
    // their own team's messages (if any), and their own DM threads.
    const myTeam = db.prepare('SELECT team FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, ctx.userId);
    const history = db.prepare(
      `SELECT * FROM room_messages WHERE room_id = ?
       AND (scope = 'lobby' OR (scope = 'team' AND team = ?) OR (scope = 'dm' AND (from_user_id = ? OR to_user_id = ?)))
       ORDER BY created_at ASC LIMIT 200`
    ).all(room.id, myTeam ? myTeam.team : null, ctx.userId, ctx.userId);
    if (history.length) {
      const users = new Map();
      for (const row of db.prepare('SELECT id, display_name, avatar_url, avatar_emoji, avatar_color FROM users').all()) users.set(row.id, row);
      sendTo(ws, {
        type: 'chat_history',
        messages: history.map((m) => {
          const u = users.get(m.from_user_id) || {};
          return {
            id: m.id, scope: m.scope, team: m.team, fromUserId: m.from_user_id, toUserId: m.to_user_id,
            displayName: u.display_name, avatarUrl: u.avatar_url, avatarEmoji: u.avatar_emoji, avatarColor: u.avatar_color,
            body: m.body, createdAt: m.created_at,
          };
        }),
      });
    }
    if (room.status === 'playing') {
      const questions = JSON.parse(room.questions_json || '[]');
      const idx = room.current_question_idx;
      if (questions[idx]) {
        sendTo(ws, { type: 'question', index: idx, total: questions.length, deadline: roomDeadlines.get(room.id) || (Date.now() + (room.question_seconds || 20) * 1000), question: safeQuestionForClient(questions[idx]) });
      }
    }
    broadcastLobby(room.id);

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

      if (msg.type === 'set_team_mode') {
        const fresh = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
        if (fresh.host_user_id === ctx.userId && fresh.status === 'lobby') {
          const on = !!msg.teamMode;
          db.prepare("UPDATE rooms SET team_mode = ?, updated_at = datetime('now') WHERE id = ?").run(on ? 1 : 0, room.id);
          if (!on) {
            db.prepare('UPDATE room_members SET team = NULL WHERE room_id = ?').run(room.id);
          } else {
            // Host turning team mode on: auto-split current players evenly A/B as a starting point.
            const activeMembers = db.prepare("SELECT user_id FROM room_members WHERE room_id = ? AND left_at IS NULL ORDER BY joined_at ASC").all(room.id);
            const teamKeys = ['A', 'B'];
            activeMembers.forEach((m, i) => {
              db.prepare('UPDATE room_members SET team = ? WHERE room_id = ? AND user_id = ?').run(teamKeys[i % teamKeys.length], room.id, m.user_id);
            });
          }
          broadcastLobby(room.id);
        }
      }

      if (msg.type === 'assign_team') {
        const fresh = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
        const targetUserId = parseInt(msg.userId, 10);
        const team = ['A', 'B', 'C', 'D'].includes(msg.team) ? msg.team : null;
        if (fresh.host_user_id === ctx.userId && fresh.status === 'lobby' && Number.isInteger(targetUserId)) {
          db.prepare('UPDATE room_members SET team = ? WHERE room_id = ? AND user_id = ?').run(team, room.id, targetUserId);
          broadcastLobby(room.id);
        }
      }

      if (msg.type === 'send_message') {
        const body = String(msg.body || '').trim().slice(0, 500);
        if (!body) return;
        const scope = ['lobby', 'team', 'dm'].includes(msg.scope) ? msg.scope : 'lobby';
        const sender = db.prepare(
          `SELECT u.display_name, u.avatar_url, u.avatar_emoji, u.avatar_color, rm.team
           FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = ? AND rm.user_id = ?`
        ).get(room.id, ctx.userId);
        if (!sender) return;

        let toUserId = null, team = null;
        if (scope === 'team') {
          team = sender.team;
          if (!team) return; // no team assigned, can't send a team message
        } else if (scope === 'dm') {
          toUserId = parseInt(msg.toUserId, 10);
          if (!Number.isInteger(toUserId)) return;
          const target = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ? AND left_at IS NULL').get(room.id, toUserId);
          if (!target) return;
        }

        const result = db.prepare(
          'INSERT INTO room_messages (room_id, from_user_id, to_user_id, team, scope, body) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(room.id, ctx.userId, toUserId, team, scope, body);

        const payload = {
          type: 'chat_message',
          id: result.lastInsertRowid,
          scope,
          team,
          fromUserId: ctx.userId,
          toUserId,
          displayName: sender.display_name,
          avatarUrl: sender.avatar_url,
          avatarEmoji: sender.avatar_emoji,
          avatarColor: sender.avatar_color,
          body,
          createdAt: new Date().toISOString(),
        };

        if (scope === 'lobby') {
          broadcast(room.id, payload);
        } else if (scope === 'team') {
          const teammates = db.prepare('SELECT user_id FROM room_members WHERE room_id = ? AND team = ? AND left_at IS NULL').all(room.id, team);
          const teammateIds = new Set(teammates.map((r) => r.user_id));
          const sockets = roomSockets.get(room.id) || new Set();
          for (const client of sockets) {
            if (teammateIds.has(client.userId)) sendTo(client.ws, payload);
          }
        } else if (scope === 'dm') {
          const sockets = roomSockets.get(room.id) || new Set();
          for (const client of sockets) {
            if (client.userId === ctx.userId || client.userId === toUserId) sendTo(client.ws, payload);
          }
        }
      }

      if (msg.type === 'get_player_stats') {
        const targetUserId = parseInt(msg.userId, 10);
        if (Number.isInteger(targetUserId)) {
          const isMember = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, targetUserId);
          if (isMember) sendTo(ws, { type: 'player_stats', stats: getPlayerStats(room.id, targetUserId) });
        }
      }

      if (msg.type === 'set_question_seconds') {
        const fresh = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
        if (fresh.host_user_id === ctx.userId && fresh.status === 'lobby') {
          const parsed = parseInt(msg.questionSeconds, 10);
          const nextSeconds = Number.isInteger(parsed) ? Math.min(60, Math.max(5, parsed)) : 20;
          db.prepare("UPDATE rooms SET question_seconds = ?, updated_at = datetime('now') WHERE id = ?").run(nextSeconds, room.id);
          broadcastLobby(room.id);
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
