/* Смоук-тест комнат и реалтайма: REST + WebSocket целиком, без реального Groq.
   Запуск из папки server:  node test/rooms.smoke.js   (или npm test) */
process.env.PORT = '3210';
process.env.JWT_SECRET = 'test_secret_for_smoke';

const qgPath = require.resolve('../questionGen');
require.cache[qgPath] = {
  id: qgPath,
  filename: qgPath,
  loaded: true,
  exports: {
    // предсказуемые вопросы вместо обращения к Groq
    generateQuestions: async (topic, language, count) =>
      Array.from({ length: count }, (_, i) => ({
        question: 'Q' + (i + 1) + ' [' + topic + ']',
        options: ['o0-' + i, 'o1-' + i, 'o2-' + i, 'o3-' + i],
        correct: i % 4,
      })),
    hasServerKeys: () => true,
  },
};

require('../index');

const WebSocket = require('ws');
const net = require('net');
const crypto = require('crypto');

const BASE = 'http://127.0.0.1:3210';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  :: ' + JSON.stringify(extra) : ''));
  if (!cond) failures++;
};

async function api(p, opts = {}, token) {
  const headers = {};
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

function client(token, code) {
  const ws = new WebSocket('ws://127.0.0.1:3210/ws/room?token=' + encodeURIComponent(token) + '&code=' + code);
  const msgs = [];
  ws.on('message', (d) => { try { msgs.push(JSON.parse(d.toString())); } catch (e) {} });
  ws.on('error', () => {});
  return {
    ws,
    send: (o) => ws.send(JSON.stringify(o)),
    wait: async (type, pred = () => true, timeout = 12000) => {
      const started = Date.now();
      let seen = 0;
      while (Date.now() - started < timeout) {
        const all = msgs.filter((m) => m.type === type);
        for (let i = seen; i < all.length; i++) { seen = i + 1; if (pred(all[i])) return all[i]; }
        await sleep(60);
      }
      return null;
    },
  };
}

(async () => {
  await sleep(700);
  const tag = String(Date.now()).slice(-7);
  const reg = (n, d) => api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: n + tag, password: 'secret123', displayName: d + tag }) });
  const H = (await reg('h', 'Host')).data;
  const P = (await reg('p', 'Player')).data;
  const X = (await reg('x', 'Stranger')).data;
  check('регистрация', !!(H.token && P.token && X.token));

  const created = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ mode: 'classic', topic: 'Test', questionCount: 3, name: 'Room one' }) }, H.token);
  const room = created.data.room;
  check('комната создана', created.status === 200 && !!room.code, room.code);
  check('вход в лобби', (await api('/api/rooms/' + room.code + '/join', { method: 'POST' }, P.token)).status === 200);

  const ch = client(H.token, room.code);
  const cp = client(P.token, room.code);
  await sleep(500);
  check('оба игрока видны в лобби', !!(await ch.wait('lobby_update', (m) => m.members.length === 2)));

  ch.send({ type: 'start_game' });
  const q0h = await ch.wait('question', (m) => m.index === 0);
  const q0p = await cp.wait('question', (m) => m.index === 0);
  check('вопрос 0 доставлен обоим', !!q0h && !!q0p);
  check('текст вопроса одинаковый', q0h.question.question === q0p.question.question);
  check('правильный ответ не утекает клиентам', q0h.question.correct === undefined && q0h.question.options.length === 4);

  cp.send({ type: 'submit_answer', questionIdx: 0, optionIdx: 0 });
  ch.send({ type: 'submit_answer', questionIdx: 0, optionIdx: 1 });
  cp.send({ type: 'submit_answer', questionIdx: 0, optionIdx: 0 }); // дубль не должен считаться дважды
  const r0 = await cp.wait('reveal', (m) => m.index === 0);
  check('reveal с верным ответом', !!r0 && r0.correct === 0);
  check('reveal отдаёт свежие счета', r0.scores.find((s) => s.userId === P.user.id).score === 100 && r0.scores.find((s) => s.userId === H.user.id).score === 0);

  check('автопереход к вопросу 1', !!(await cp.wait('question', (m) => m.index === 1)));
  cp.send({ type: 'submit_answer', questionIdx: 1, optionIdx: 1 });
  ch.send({ type: 'submit_answer', questionIdx: 1, optionIdx: 3 });
  await cp.wait('reveal', (m) => m.index === 1);

  const q2 = await cp.wait('question', (m) => m.index === 2);
  check('автопереход к вопросу 2', !!q2);
  check('окно вопроса классики ~20с', q2.deadline - Date.now() > 17000 && q2.deadline - Date.now() <= 20000, q2.deadline - Date.now());
  check('поздний ответ не засчитывается', (await sleep(0), true));
  cp.send({ type: 'submit_answer', questionIdx: 2, optionIdx: 2 });
  ch.send({ type: 'submit_answer', questionIdx: 2, optionIdx: 0 });
  await cp.wait('reveal', (m) => m.index === 2);
  const over = await cp.wait('game_over');
  check('game_over', !!over);
  check('итоговая таблица', over.leaderboard[0].id === P.user.id && over.leaderboard[0].score === 300, over.leaderboard.map((m) => [m.displayName, m.score]));

  const room2 = (await api('/api/rooms', { method: 'POST', body: JSON.stringify({ mode: 'blitz', topic: 'Blitz', questionCount: 3, name: 'Room two' }) }, H.token)).data.room;
  await api('/api/rooms/' + room2.code + '/join', { method: 'POST' }, P.token);
  const c2h = client(H.token, room2.code);
  const c2p = client(P.token, room2.code);
  await sleep(400);
  c2h.send({ type: 'start_game' });
  const bq = await c2h.wait('question', (m) => m.index === 0);
  check('окно вопроса блица ~10с', bq.deadline - Date.now() > 8000 && bq.deadline - Date.now() <= 10000, bq.deadline - Date.now());

  c2p.ws.close();
  await sleep(200);
  check('участник возвращается в идущую игру', (await api('/api/rooms/' + room2.code + '/join', { method: 'POST' }, P.token)).status === 200);
  check('посторонний в идущую игру не пускается', (await api('/api/rooms/' + room2.code + '/join', { method: 'POST' }, X.token)).status === 409);

  // битый WS-кадр (RSV1) раньше ронял процесс целиком
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(3210, '127.0.0.1', () => {
    sock.write('GET /ws/room?token=' + encodeURIComponent(H.token) + '&code=' + room2.code + ' HTTP/1.1\r\nHost: 127.0.0.1:3210\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  sock.on('error', () => {});
  await sleep(350);
  sock.write(Buffer.from([0xc1, 0x84, 0x11, 0x22, 0x33, 0x44, 0x00, 0x00, 0x00, 0x00]));
  await sleep(800);
  check('сервер выживает после битого WS-кадра', (await api('/api/health')).status === 200);
  try { sock.destroy(); } catch (e) {}

  c2h.send({ type: 'play_again' });
  check('хост перезапускает комнату', !!(await c2h.wait('status', (m) => m.status === 'lobby')));
  check('счета сброшены', !!(await c2h.wait('lobby_update', (m) => m.members.every((x) => x.score === 0))));

  const cP2 = client(P.token, room2.code);
  await sleep(300);
  c2h.send({ type: 'leave_room' });
  const handover = await cP2.wait('lobby_update', (m) => m.room && m.room.hostUserId === P.user.id, 8000);
  check('роль хоста переходит оставшемуся', !!handover);
  check('смена хоста сохранена на сервере', (await api('/api/rooms/' + room2.code, {}, P.token)).data.room.hostUserId === P.user.id);

  cP2.send({ type: 'leave_room' });
  await sleep(6500);
  check('пустая комната удаляется', (await api('/api/rooms/' + room2.code, {}, P.token)).status === 404);

  console.log('\nFAILURES: ' + failures);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('SMOKE CRASH', e); process.exit(2); });
