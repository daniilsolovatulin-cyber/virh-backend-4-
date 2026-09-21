/* Смоук-тест фронтенда без браузера: минимальная заглушка DOM + проверка логики.
   Запуск: node test/frontend.smoke.js   (или npm test из папки server) */

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.join(__dirname, '..', '..');

function makeEl(id) {
  const el = { id, innerHTML: '', value: '', disabled: false, files: [], style: {}, dataset: {}, _text: '' };
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(v) { el._text = String(v); el.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  });
  const classes = new Set();
  el.classList = {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : on ? classes.add(c) : classes.delete(c)),
    contains: (c) => classes.has(c),
  };
  el.classes = classes;
  let htmlWrites = 0;
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html || ''; },
    set(v) { el._html = String(v); el._writes = ++htmlWrites; },
  });
  el.setAttribute = () => {}; el.getAttribute = () => null;
  el.addEventListener = () => {}; el.removeEventListener = () => {};
  el.appendChild = () => {}; el.remove = () => {}; el.focus = () => {};
  el.querySelector = () => null; el.querySelectorAll = () => [];
  return el;
}
const els = new Map();
globalThis.document = {
  documentElement: makeEl('html'), body: makeEl('body'),
  getElementById: (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
  querySelector: () => null, querySelectorAll: () => [],
  createElement: (t) => makeEl(t), addEventListener: () => {}, removeEventListener: () => {},
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', port: '3001', protocol: 'http:', origin: 'http://localhost:3001', href: 'http://localhost:3001/' };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.requestAnimationFrame = () => 0;
globalThis.Audio = function () { return { play: () => Promise.resolve(), pause() {}, addEventListener() {} }; };
globalThis.WebSocket = function () { return {}; };
globalThis.WebSocket.OPEN = 1;
globalThis.navigator = { clipboard: { writeText: () => Promise.resolve() } };

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  :: ' + JSON.stringify(extra) : ''));
  if (!cond) failures++;
};

(async () => {
  for (const f of ['config.js', 'icons.js', 'api.js', 'sound.js', 'app.js']) {
    const code = fs.readFileSync(path.join(root, 'public', f), 'utf8');
    try { vm.runInThisContext(code, { filename: f }); }
    catch (e) { check('load ' + f, false, e.message); process.exit(1); }
  }
  check('all frontend scripts load', true);

  const views = ['home', 'auth', 'profile', 'setup', 'generating', 'quiz', 'result', 'todSetup', 'tod', 'roomCreate', 'roomJoin', 'roomLobby', 'roomPlay', 'roomResult'];
  state.user = { id: 1, username: 'u', displayName: 'U', avatarEmoji: '🙂', avatarColor: '#3D3AF1', avatarUrl: null };
  state.questions = [{ question: 'Q?', options: ['a', 'b', 'c', 'd'], correct: 1 }];
  state.room = { code: 'ABC12', name: 'R', topic: 'Test', hostUserId: 1, maxPlayers: 0, questionCount: 5, mode: 'blitz', status: 'generating' };
  state.roomMembers = [{ id: 1, displayName: 'U', score: 0 }];
  state.wsLeaderboard = [{ id: 1, displayName: 'U', score: 100 }];
  state.wsQuestion = { index: 0, total: 3, deadline: Date.now() + 20000, question: { question: 'Q?', options: ['a', 'b', 'c', 'd'] } };
  for (const v of views) {
    state.view = v;
    try { const html = viewHTML(); render(); check('view renders: ' + v, typeof html === 'string' && html.length > 0); }
    catch (e) { check('view renders: ' + v, false, e.message); }
  }

  const genHtml = generatingHTML();
  check('generating: таймер «прошло» сверху', genHtml.includes('id="genElapsed"'));
  check('generating: таймер «осталось»', genHtml.includes('id="genEta"'));
  check('generating: кнопка «Отменить»', genHtml.includes('id="genCancelBtn"'));
  check('generating: размытый предпросмотр данных', genHtml.includes('gen-preview') && genHtml.includes('question-card'));
  check('generating: подсказка темы внутри размытия', /gen-preview[\s\S]*question-category/.test(genHtml));

  state.view = 'roomLobby';
  const lobbyHtml = roomLobbyHTML();
  check('лобби: таймер генерации', lobbyHtml.includes('id="roomGenElapsed"'));
  check('лобби: размытое превью пока ИИ ищет', lobbyHtml.includes('gen-preview'));

  state.room.status = 'playing';
  state.wsQuestion = null;
  check('ожидание первого вопроса с превью', roomPlayHTML().includes('gen-preview'));

  check('formatClock 0 -> 0:00', formatClock(0) === '0:00');
  check('formatClock 65s -> 1:05', formatClock(65000) === '1:05');

  let lastRequest = null;
  globalThis.fetch = async (url, opts) => {
    lastRequest = { url, opts };
    return { ok: true, status: 200, json: async () => ({ questions: [{ question: 'Q', options: ['a', 'b'], correct: 0 }] }) };
  };
  const generated = await generateQuestionsLocal('Тест', 'Русский', 3, () => {}, 'any', 'gsk_temporary', true);
  const soloPayload = JSON.parse(lastRequest.opts.body);
  check('одиночная игра получает вопросы через сервер', generated.length === 1 && /api\/solo\/questions$/.test(lastRequest.url));
  check('ключ и точный режим передаются только в запросе', soloPayload.apiKey === 'gsk_temporary' && soloPayload.exactFacts === true);

  state.view = 'generating';
  bindGenerating();
  document.getElementById('genCancelBtn').onclick();
  check('отмена возвращает на экран настройки', state.view === 'setup' && state.genCancelled === true);

  // ---------- управление ----------
  state.view = 'quiz';
  state.questions = [{ question: 'Q?', options: ['a', 'b', 'c', 'd'], correct: 1 }];
  check('в одиночной викторине есть выход на экране', quizHTML().includes('id="leaveQuizBtn"'));
  bindQuiz();
  document.getElementById('leaveQuizBtn').onclick();
  check('выход из викторины возвращает на главную', state.view === 'home');

  // ---------- переходы между экранами ----------
  render();
  const header = document.getElementById('appHeader');
  const mainEl = document.getElementById('appMain');
  const writesAfterFirst = header._writes;
  render();
  render();
  check('шапка не пересоздаётся без изменений (нет мелькания)', header._writes === writesAfterFirst, { writes: header._writes });
  check('текущий экран не перелистывается повторно', !mainEl.classList.contains('page-in'));

  state.view = 'home';
  render();
  check('переход вперёд помечен как forward', document.documentElement.dataset.nav === 'forward');
  state.view = 'setup';
  render();
  check('переход глубже — forward', document.documentElement.dataset.nav === 'forward');
  state.view = 'home';
  render();
  check('возврат помечен как back', document.documentElement.dataset.nav === 'back');
  check('запасная анимация страницы применена только при переходе', mainEl.classList.contains('page-in'));

  // браузер с View Transitions: анимацию листает сам браузер
  let vtUsed = false;
  document.startViewTransition = (cb) => { vtUsed = true; cb(); return { finished: Promise.resolve() }; };
  mainEl.classList.remove('page-in');
  state.view = 'setup';
  render();
  check('View Transitions используется, когда доступен', vtUsed);
  check('в этом режиме запасной класс не нужен', !mainEl.classList.contains('page-in'));
  delete document.startViewTransition;

  console.log('\nFAILURES: ' + failures);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASH', e); process.exit(2); });
