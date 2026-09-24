/* ============================================================
   Вихрь — фронтенд
   Одиночный режим работает как раньше (ключи Groq в браузере).
   Режим "Играть с друзьями" ходит на сервер: аккаунты, комнаты,
   генерация вопросов на сервере, синхронизация через WebSocket.
   ============================================================ */

/* ============ STATE ============ */
const state = {
  // auth
  user: null, // {id, username, displayName, avatarUrl, avatarEmoji, avatarColor}
  authError: '',
  authBusy: false,

  // theme / local settings
  // A personal key is optional and lives only until this tab is closed.
  // The normal path uses the protected key pool on the server.
  generatorKey: '',
  exactFacts: true,
  theme: localStorage.getItem('quiz_theme') || 'auto',

  // routing
  view: 'home', // see viewHTML()
  authMode: 'login', // 'login' | 'register'
  returnView: null, // view to go back to when leaving profile/settings (e.g. 'roomLobby')

  // solo setup
  setupMode: null, // 'classic' | 'blitz'
  selectedTopic: '',
  customTopic: '',
  language: 'Русский',
  questionCount: 8,
  blitzSeconds: 60,
  perQuestionTimerEnabled: true,
  perQuestionSeconds: 20,
  soloQuestionDeadline: 0,
  questions: [],
  genProgress: 0,
  genTotal: 0,
  roomGenPercent: 0,
  currentIndex: 0,
  score: 0,
  answered: null,
  timeLeft: 0,
  timerInterval: null,
  ageGroup: 'any',
  interest: '',

  // truth or dare (solo/local group)
  groupMode: false,
  playerCount: 4,
  playerNames: ['Игрок 1', 'Игрок 2', 'Игрок 3', 'Игрок 4'],
  playerScores: [0, 0, 0, 0],
  currentPlayerIdx: 0,

  // online rooms
  roomJoinCode: '',
  room: null, // {code, mode, topic, language, questionCount, status, currentQuestionIdx, hostUserId}
  roomMembers: [],
  roomError: '',
  roomBusy: false,
  ws: null,
  wsQuestion: null, // {index, total, question:{question, options}}
  wsDeadline: 0,
  roomTimerInterval: null,
  wsAnswered: false,
  wsAnsweredUsers: [],
  wsReveal: null, // {correct, answers, scores}
  wsLeaderboard: null,
  wsReconnecting: false,
  knownMemberIds: null, // Set of member ids seen in the lobby so far, for join-animation diffing
  roomSetup: { mode: 'classic', topic: '', customTopic: '', name: '', language: 'Русский', questionCount: 10, maxPlayers: 0, password: '', questionSeconds: 20 },
  browseRooms: null, // null = not fetched yet (shows loader once); [] = fetched, empty
  browseRoomsLoading: false,
  homeBrowseLoading: false,
  browseRoomsError: '',
  roundStartShown: false,

  // team mode
  teamStandings: null, // [{team, name, color, score, members}] while a room has team_mode on
  prevLeaderboardOrder: [], // userId order from the previous game_over paint, for animated deltas

  // chat
  chatMessages: [], // {id, scope: 'lobby'|'team'|'dm', team, fromUserId, toUserId, displayName, avatarUrl, avatarEmoji, avatarColor, body, createdAt}
  chatUnread: 0,
  chatScope: 'lobby', // 'lobby' | 'team' | 'dm'
  chatDmUserId: null,

  // player profile modal
  viewedPlayerStats: null, // filled by 'player_stats' ws response
};

const MAX_PLAYERS_OPTIONS = [0, 2, 4, 6, 8, 12]; // 0 = no limit
const QUESTION_SECONDS_OPTIONS = [10, 15, 20, 30, 45, 60];

const TOPIC_PRESETS = [
  'История', 'Наука', 'Кино', 'Музыка', 'Спорт', 'География',
  'Технологии', 'Литература', 'Игры', 'Космос', 'Кухни мира', 'Мифология',
];
const LANGUAGES = ['Русский', 'English', 'Español', 'Deutsch', 'Français', '日本語'];

const AGE_GROUPS = [
  { id: 'kids', label: '7–12 лет' },
  { id: 'teen', label: '13–17 лет' },
  { id: 'adult', label: '18+' },
  { id: 'any', label: 'Без разницы' },
];
const AGE_PROMPT_HINTS = {
  kids: 'Вопросы и задания должны быть простыми, безопасными и подходящими для детей 7-12 лет — никакой пошлости, жестокости или сложной терминологии.',
  teen: 'Вопросы и задания должны подходить подросткам 13-17 лет — интересные, современные, без грубости и пошлости.',
  adult: 'Вопросы и задания рассчитаны на взрослую аудиторию 18+, можно чуть дерзкие и раскрепощённые, но без оскорблений и explicit контента.',
  any: 'Аудитория смешанная по возрасту, держи тон нейтральным и безобидным для всех.',
};
const INTEREST_PRESETS = ['Кино и сериалы', 'Музыка', 'Игры', 'Спорт', 'Путешествия', 'Юмор', 'Отношения', 'Еда', 'Технологии', 'Общее'];
const EMOJI_CHOICES = ['🙂', '😎', '🤓', '🥳', '🦊', '🐼', '🐸', '🐧', '🦉', '🐙', '🦄', '🐢', '🌟', '🔥', '⚡', '🎯'];
const COLOR_CHOICES = ['#3D3AF1', '#B23B2C', '#3D7A54', '#A8710E', '#7A3AF1', '#0E7A8A', '#C24C86', '#4A5568'];

/* ============ THEME ============ */
function applyTheme() {
  let effective = state.theme;
  if (effective === 'auto') {
    effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', effective);
}
applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.theme === 'auto') applyTheme();
});

/* ============ HELPERS ============ */
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function showToast(msg, icon) {
  const t = document.getElementById('toast');
  t.innerHTML = (icon || ICONS.check) + '<span>' + escapeHtml(msg) + '</span>';
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2800);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function avatarHTML(entity, size) {
  // entity: {avatarUrl, avatarEmoji, avatarColor, displayName}
  const cls = 'avatar' + (size ? ' ' + size : '');
  if (entity && entity.avatarUrl) {
    const url = Api.avatarFullUrl(entity.avatarUrl);
    return `<span class="${cls}"><img src="${url}" alt=""></span>`;
  }
  const color = (entity && entity.avatarColor) || '#3D3AF1';
  const emoji = (entity && entity.avatarEmoji) || '🙂';
  return `<span class="${cls}" style="background:${color}22;">${emoji}</span>`;
}

const ROOM_VIEWS = new Set(['roomLobby', 'roomPlay', 'roomResult']);

// Header's home/brand buttons are one click away from every screen, including mid-game —
// so leaving a room through them asks first instead of tearing the room down immediately.
// The explicit "Выйти из лобби/комнаты" buttons on the room screens themselves skip the
// confirm: clicking a button labeled "leave" is already the deliberate action.
// Header's home/brand buttons are one click away from every screen, including mid-game —
// so leaving a room through them asks first instead of tearing the room down immediately.
// The explicit "Выйти из лобби/комнаты" buttons on the room screens themselves skip the
// confirm: clicking a button labeled "leave" is already the deliberate action.
// From the profile/settings screen, if we got there from an active room, "home" instead
// returns to that room — the room was never left, so there's nothing to confirm.
function goHomeFromHeader() {
  if (ROOM_VIEWS.has(state.view) && state.room) {
    openLeaveRoomConfirm();
    return;
  }
  if (state.returnView && state.room) {
    returnToRoom();
    return;
  }
  goHome();
}

function returnToRoom() {
  state.view = state.returnView;
  state.returnView = null;
  render();
}

function goHome() {
  stopTimer();
  Sound.stopMusic({ fade: false });
  leaveCurrentRoom();
  state.returnView = null;
  state.view = 'home';
  render();
}

function openLeaveRoomConfirm() {
  const titleEl = document.getElementById('leaveRoomTitle');
  const bodyEl = document.getElementById('leaveRoomBody');
  if (state.view === 'roomPlay') {
    titleEl.textContent = 'Выйти из игры?';
    bodyEl.textContent = 'Игра идёт прямо сейчас — если выйдешь, пропустишь оставшиеся вопросы и придётся заново вводить код, чтобы вернуться.';
  } else if (state.view === 'roomResult') {
    titleEl.textContent = 'На главную?';
    bodyEl.textContent = 'Ты выйдешь из комнаты. Чтобы сыграть с этой же компанией снова, нужен будет код лобби.';
  } else {
    titleEl.textContent = 'Выйти из лобби?';
    bodyEl.textContent = 'Если выйдешь, придётся заново вводить код комнаты, чтобы вернуться.';
  }
  document.getElementById('leaveRoomOverlay').classList.add('open');
}

function closeLeaveRoomConfirm() {
  document.getElementById('leaveRoomOverlay').classList.remove('open');
}

function confirmLeaveRoom() {
  closeLeaveRoomConfirm();
  goHome();
}

function stopRoomTimer() {
  if (state.roomTimerInterval) {
    clearInterval(state.roomTimerInterval);
    state.roomTimerInterval = null;
  }
}

function leaveCurrentRoom() {
  stopRoomTimer();
  if (state.room && state.ws) sendRoomMessage({ type: 'leave_room' });
  disconnectRoomSocket();
  state.room = null;
  state.roomMembers = [];
  state.wsQuestion = null;
  state.wsReveal = null;
  state.wsLeaderboard = null;
  state.knownMemberIds = null;
}

/* ============ RENDER: ROOT ============ */
let isFirstRender = true;

let lastRenderedView = null;
let lastHeaderHTML = null;

function render() {
  const headerEl = document.getElementById('appHeader');
  const main = document.getElementById('appMain');

  // The header only actually changes when the view switches in/out of 'home',
  // the user logs in/out, or their name/avatar changes — not on every WS
  // message or timer tick that calls render(). Rebuilding it unconditionally
  // used to repaint the header (and drop any in-progress interaction with it)
  // on every single re-render; skip the rebuild when nothing changed.
  const nextHeaderHTML = headerHTML();
  if (nextHeaderHTML !== lastHeaderHTML) {
    headerEl.innerHTML = nextHeaderHTML;
    lastHeaderHTML = nextHeaderHTML;
    bindHeader();
  }

  const html = viewHTML();
  const sameView = !isFirstRender && state.view === lastRenderedView;
  lastRenderedView = state.view;

  if (isFirstRender) {
    main.innerHTML = html;
    bindView();
    isFirstRender = false;
    return;
  }

  // Re-rendering the *same* screen (a data update, not a screen change) still
  // replaces appMain's whole innerHTML — that's the cheapest way to keep this
  // codebase's render model simple — but every element carrying `.view` would
  // otherwise replay its entrance fade/slide as if the screen had just been
  // opened, which is exactly the flicker. Add a class that kills the
  // animation via the stylesheet BEFORE the new HTML is inserted, so there is
  // no frame in which the browser could ever paint the animation's "from"
  // state (opacity 0 / translateY) — flipping el.style.animation after
  // insertion left a race on exactly that.
  if (sameView) main.classList.add('no-entrance-anim');
  else main.classList.remove('no-entrance-anim');

  main.innerHTML = html;
  bindView();
}

function headerHTML() {
  return `
    <div class="shell-header">
      <button class="brand" id="btnBrandHome">
        <span class="brand-mark">${ICONS.logo}</span>
        Вихрь
      </button>
      <div class="header-actions">
        ${state.view !== 'home' ? `<button class="icon-btn" id="btnHome" title="На главную">${ICONS.home}</button>` : ''}
        <button class="icon-btn" id="btnSettings" title="Оформление">${ICONS.settings}</button>
        ${state.user
          ? `<button class="account-chip" id="btnAccount">${avatarHTML(state.user)}${escapeHtml(state.user.displayName)}</button>`
          : `<button class="btn-ghost" id="btnLoginHeader">${ICONS.logIn} Войти</button>`
        }
      </div>
    </div>
  `;
}

function bindHeader() {
  document.getElementById('btnBrandHome').onclick = () => goHomeFromHeader();
  const h = document.getElementById('btnHome');
  if (h) h.onclick = () => goHomeFromHeader();
  document.getElementById('btnSettings').onclick = openSettings;
  const acc = document.getElementById('btnAccount');
  if (acc) acc.onclick = () => { state.returnView = ROOM_VIEWS.has(state.view) ? state.view : null; state.view = 'profile'; render(); };
  const loginBtn = document.getElementById('btnLoginHeader');
  if (loginBtn) loginBtn.onclick = () => { state.authMode = 'login'; state.authError = ''; state.view = 'auth'; render(); };
}

/* ============ VIEW ROUTER ============ */
function viewHTML() {
  switch (state.view) {
    case 'home': return homeHTML();
    case 'auth': return authHTML();
    case 'profile': return profileHTML();
    case 'setup': return setupHTML();
    case 'generating': return generatingHTML();
    case 'quiz': return quizHTML();
    case 'result': return resultHTML();
    case 'todSetup': return todSetupHTML();
    case 'tod': return todHTML();
    case 'roomCreate': return roomCreateHTML();
    case 'roomJoin': return roomJoinHTML();
    case 'roomLobby': return roomLobbyHTML();
    case 'roomPlay': return roomPlayHTML();
    case 'roomResult': return roomResultHTML();
    default: return homeHTML();
  }
}

function bindView() {
  switch (state.view) {
    case 'home': return bindHome();
    case 'auth': return bindAuth();
    case 'profile': return bindProfile();
    case 'setup': return bindSetup();
    case 'quiz': return bindQuiz();
    case 'result': return bindResult();
    case 'todSetup': return bindTodSetup();
    case 'tod': return bindTod();
    case 'roomCreate': return bindRoomCreate();
    case 'roomJoin': return bindRoomJoin();
    case 'roomLobby': return bindRoomLobby();
    case 'roomPlay': return bindRoomPlay();
    case 'roomResult': return bindRoomResult();
  }
}

/* ============ HOME ============ */
function homeHTML() {
  return `
    <div class="panel hero view">
      <h1>Собери викторину за секунды</h1>
      <p>Задай тему на любом языке — сервис придумает вопросы. Играй один или позови друзей в общую комнату.</p>
    </div>

    <div class="section-label">Сейчас играют</div>
    <div id="homeBrowseWrap">${homeBrowseRoomsHTML()}</div>

    <div class="section-label">С друзьями</div>
    <div class="mode-grid">
      <div class="mode-card featured view" data-mode="roomCreate">
        <div class="mode-badge">Онлайн</div>
        <div class="mode-title">Создать комнату</div>
        <div class="mode-desc">Общий счёт, вопросы для всех сразу, живой список игроков.</div>
      </div>
      <div class="mode-card view" data-mode="roomJoin">
        <div class="mode-icon mode-icon-violet">${ICONS.users}</div>
        <div>
          <div class="mode-title">Войти по коду</div>
          <div class="mode-desc">Есть код комнаты от друга — заходи прямо сюда.</div>
        </div>
      </div>
    </div>

    <div class="section-label">В одиночку</div>
    <div class="mode-grid">
      <div class="mode-card view" data-mode="classic">
        <div class="mode-icon mode-icon-green">${ICONS.book}</div>
        <div>
          <div class="mode-title">Классика</div>
          <div class="mode-desc">Вопросы по теме, без спешки, с подсчётом верных ответов.</div>
        </div>
      </div>
      <div class="mode-card view" data-mode="blitz">
        <div class="mode-icon mode-icon-amber">${ICONS.bolt}</div>
        <div>
          <div class="mode-title">Блиц</div>
          <div class="mode-desc">Общий таймер на игру — успей ответить на максимум вопросов.</div>
        </div>
      </div>
    </div>

    <div class="section-label">Мини-игра</div>
    <div class="mode-grid">
      <div class="mode-card view" data-mode="tod">
        <div class="mode-icon mode-icon-pink">${ICONS.heart}</div>
        <div>
          <div class="mode-title">Правда или действие</div>
          <div class="mode-desc">Карточки на лету, для одного или компании до 4 человек по очереди.</div>
        </div>
      </div>
    </div>
  `;
}

/* Compact live-rooms teaser for the home screen — reuses the same browseRooms
   API/state as the "join by code" screen so it's real data, not a mock. Shows
   at most 3 rows; "смотреть все" hands off to the full browse screen. Kept out
   of the way (no fetch) for logged-out visitors, who see a plain CTA instead
   since browsing rooms requires auth anyway. */
function homeBrowseRoomsHTML() {
  if (!state.user) {
    return `
      <div class="panel home-browse-cta" id="homeBrowseCta">
        ${ICONS.users}
        <div class="sub">Войди, чтобы увидеть открытые комнаты друзей и незнакомцев прямо сейчас.</div>
      </div>
    `;
  }
  if (state.homeBrowseLoading) {
    return `<div class="empty-state" style="padding:18px;">${LOADER('full')}</div>`;
  }
  const rooms = (state.browseRooms || []).slice(0, 3);
  if (!rooms.length) {
    return `<div class="empty-state" style="padding:18px;">${ICONS.users}<div class="sub">Открытых комнат сейчас нет — стань первым, создай свою.</div></div>`;
  }
  return `
    <div class="room-browse-list">
      ${rooms.map((r, i) => `
        <div class="panel room-browse-row" data-code="${escapeHtml(r.code)}" style="--stagger:${i}; animation: memberIn 0.26s cubic-bezier(0.16,1,0.3,1) both; animation-delay: calc(${i} * 0.05s);">
          <div class="room-browse-main">
            <div class="room-browse-name">${escapeHtml(r.name || r.topic)} ${r.hasPassword ? `<span class="room-lock-badge" title="Требуется пароль">${ICONS.lock}</span>` : ''}</div>
            <div class="room-browse-meta">
              <span class="chip" style="cursor:default;">${r.mode === 'blitz' ? 'Блиц' : 'Классика'}</span>
              <span class="room-browse-count">${ICONS.users} ${r.memberCount}${r.maxPlayers ? ' / ' + r.maxPlayers : ''}</span>
            </div>
          </div>
          <button class="btn-primary home-browse-join" data-code="${escapeHtml(r.code)}" style="width:auto; padding:0 16px;">${ICONS.arrowRight} Войти</button>
        </div>
      `).join('')}
    </div>
    ${(state.browseRooms || []).length > 3 ? `<button class="btn-ghost" id="homeBrowseMoreBtn" style="margin-top:8px;">Смотреть все (${state.browseRooms.length})</button>` : ''}
  `;
}

async function loadHomeBrowseRooms() {
  if (!state.user) return;
  state.homeBrowseLoading = true;
  const wrap = document.getElementById('homeBrowseWrap');
  if (wrap) wrap.innerHTML = homeBrowseRoomsHTML();
  try {
    const { rooms } = await Api.browseRooms();
    state.browseRooms = rooms;
  } catch (err) {
    state.browseRooms = [];
  }
  state.homeBrowseLoading = false;
  const wrap2 = document.getElementById('homeBrowseWrap');
  if (wrap2) { wrap2.innerHTML = homeBrowseRoomsHTML(); bindHomeBrowseRooms(); }
}

function bindHomeBrowseRooms() {
  document.querySelectorAll('.home-browse-join').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      joinRoomByCode(btn.dataset.code);
    };
  });
  const moreBtn = document.getElementById('homeBrowseMoreBtn');
  if (moreBtn) moreBtn.onclick = () => { state.roomError = ''; state.view = 'roomJoin'; render(); };
  const cta = document.getElementById('homeBrowseCta');
  if (cta) cta.onclick = () => requireAuth();
}

function bindHome() {
  document.querySelectorAll('.mode-card[data-mode]').forEach((card) => {
    card.onclick = () => {
      const mode = card.dataset.mode;
      if (mode === 'roomCreate') {
        if (!requireAuth()) return;
        state.view = 'roomCreate';
        render();
        return;
      }
      if (mode === 'roomJoin') {
        if (!requireAuth()) return;
        state.roomError = '';
        state.view = 'roomJoin';
        render();
        return;
      }
      if (mode === 'tod') {
        state.setupMode = 'tod';
        state.view = 'todSetup';
        render();
        return;
      }
      state.setupMode = mode;
      state.view = 'setup';
      render();
    };
  });
  bindHomeBrowseRooms();
  if (state.user) loadHomeBrowseRooms();
}

function requireAuth() {
  if (!state.user) {
    state.authMode = 'login';
    state.authError = '';
    state.view = 'auth';
    render();
    showToast('Сначала войди или зарегистрируйся', ICONS.user);
    return false;
  }
  return true;
}

function ensureLocalKey() {
  return true;
}

/* ============ AUTH ============ */
function authHTML() {
  const isLogin = state.authMode === 'login';
  return `
    <div class="auth-wrap view">
      <div class="panel auth-card">
        <div class="auth-title">${isLogin ? 'Вход' : 'Регистрация'}</div>
        <div class="auth-sub">${isLogin ? 'Заходи, чтобы создавать комнаты и играть с друзьями.' : 'Аккаунт нужен для комнат с друзьями и профиля.'}</div>
        ${state.authError ? `<div class="auth-error">${escapeHtml(state.authError)}</div>` : ''}
        <form id="authForm">
          <div class="field">
            <label>Имя пользователя</label>
            <input type="text" id="authUsername" autocomplete="username" placeholder="latin_letters_digits" required>
          </div>
          ${!isLogin ? `
          <div class="field">
            <label>Отображаемое имя</label>
            <input type="text" id="authDisplayName" placeholder="Как тебя видят другие игроки" maxlength="40">
          </div>` : ''}
          <div class="field">
            <label>Пароль</label>
            <input type="password" id="authPassword" autocomplete="${isLogin ? 'current-password' : 'new-password'}" placeholder="Минимум 6 символов" required>
          </div>
          <button class="btn-primary" id="authSubmit" type="submit" ${state.authBusy ? 'disabled' : ''}>
            ${state.authBusy ? LOADER('inline') : (isLogin ? ICONS.logIn : ICONS.user)}
            ${isLogin ? 'Войти' : 'Создать аккаунт'}
          </button>
        </form>
        <div class="auth-switch">
          ${isLogin ? 'Нет аккаунта?' : 'Уже есть аккаунт?'}
          <button class="link-btn" id="authSwitch">${isLogin ? 'Зарегистрироваться' : 'Войти'}</button>
        </div>
      </div>
    </div>
  `;
}

function bindAuth() {
  document.getElementById('authSwitch').onclick = () => {
    state.authMode = state.authMode === 'login' ? 'register' : 'login';
    state.authError = '';
    render();
  };

  document.getElementById('authForm').onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('authUsername').value.trim();
    const password = document.getElementById('authPassword').value;
    const displayNameEl = document.getElementById('authDisplayName');
    const displayName = displayNameEl ? displayNameEl.value.trim() : '';

    state.authError = '';
    state.authBusy = true;
    render();

    try {
      const result = state.authMode === 'login'
        ? await Api.login(username, password)
        : await Api.register(username, password, displayName);
      Api.setToken(result.token);
      state.user = result.user;
      state.authBusy = false;
      state.view = 'home';
      render();
      showToast(state.authMode === 'login' ? 'С возвращением, ' + result.user.displayName : 'Аккаунт создан');
    } catch (err) {
      state.authBusy = false;
      state.authError = authErrorMessage(err);
      render();
    }
  };
}

function authErrorMessage(err) {
  if (err.network) return 'Не удалось связаться с сервером. Проверь подключение.';
  if (err.code === 'invalid_username') return 'Имя пользователя: 3-20 символов, латиница/цифры/подчёркивание.';
  if (err.code === 'invalid_password') return 'Пароль минимум 6 символов.';
  if (err.code === 'username_taken') return 'Это имя пользователя уже занято.';
  if (err.code === 'invalid_credentials') return 'Неверное имя пользователя или пароль.';
  return err.message || 'Что-то пошло не так.';
}

async function tryRestoreSession() {
  if (!Api.getToken()) return;
  try {
    const { user } = await Api.me();
    state.user = user;
  } catch (e) {
    Api.setToken(null);
  }
}

function logout() {
  Api.setToken(null);
  state.user = null;
  disconnectRoomSocket();
  state.room = null;
  state.roomMembers = [];
  state.returnView = null;
  state.knownMemberIds = null;
  state.view = 'home';
  render();
  showToast('Вы вышли из аккаунта');
}

/* ============ PROFILE ============ */
function profileHTML() {
  const u = state.user;
  if (!u) { state.view = 'auth'; return authHTML(); }
  return `
    ${state.returnView && state.room ? `
      <button class="btn-secondary" id="backToRoomBtn" style="margin-bottom:16px; display:flex; align-items:center; justify-content:center; gap:8px;">
        ${ICONS.arrowLeft} Вернуться в лобби
      </button>
    ` : ''}
    <div class="panel profile-head view">
      <div class="avatar-picker">
        ${avatarHTML(u, 'lg')}
        <label class="avatar-edit-btn" title="Загрузить фото">
          ${ICONS.camera}
          <input type="file" id="avatarFileInput" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none;">
        </label>
      </div>
      <div>
        <div style="font-weight:700; font-size:17px;">${escapeHtml(u.displayName)}</div>
        <div style="color:var(--ink-soft); font-size:13px;">@${escapeHtml(u.username)}</div>
        ${u.avatarUrl ? `<button class="btn-danger-text" id="removeAvatarBtn" style="margin-top:6px;">Удалить фото</button>` : ''}
      </div>
    </div>

    <div class="section-label">Имя</div>
    <div class="panel" style="padding:18px;">
      <div class="field" style="margin-bottom:10px;">
        <input type="text" id="displayNameInput" value="${escapeHtml(u.displayName)}" maxlength="40">
      </div>
      <button class="btn-secondary" id="saveNameBtn">Сохранить имя</button>
    </div>

    <div class="section-label">Аватар без фото</div>
    <div class="panel" style="padding:18px;">
      <div class="field">
        <label>Эмодзи</label>
        <div class="emoji-grid" id="emojiGrid">
          ${EMOJI_CHOICES.map((e) => `<div class="emoji-opt ${u.avatarEmoji === e ? 'active' : ''}" data-emoji="${e}">${e}</div>`).join('')}
        </div>
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Цвет фона</label>
        <div class="color-grid" id="colorGrid">
          ${COLOR_CHOICES.map((c) => `<div class="color-opt ${u.avatarColor === c ? 'active' : ''}" data-color="${c}" style="background:${c}"></div>`).join('')}
        </div>
      </div>
    </div>

    <div class="section-label">Звук</div>
    <div class="panel" style="padding:18px;">
      <div class="sound-toggle-row">
        <span>Звуки и музыка</span>
        <button class="switch ${Sound.isMuted() ? '' : 'on'}" id="soundMuteSwitch" role="switch" aria-checked="${!Sound.isMuted()}"><span class="switch-knob"></span></button>
      </div>
      <div class="field" style="margin-top:14px; margin-bottom:10px;">
        <label>Громкость эффектов</label>
        <input type="range" id="sfxVolumeSlider" min="0" max="100" value="${Math.round(Sound.getSfxVolume() * 100)}">
      </div>
      <div class="field" style="margin-bottom:12px;">
        <label>Громкость музыки</label>
        <input type="range" id="musicVolumeSlider" min="0" max="100" value="${Math.round(Sound.getMusicVolume() * 100)}">
      </div>
      <button class="btn-ghost" id="testSoundBtn" style="width:auto; padding:8px 14px; font-size:13px;">${ICONS.check} Проверить звук</button>
    </div>

    <div class="section-label">Пароль</div>
    <div class="panel" style="padding:18px;">
      <div class="field">
        <label>Текущий пароль</label>
        <input type="password" id="currentPasswordInput" autocomplete="current-password">
      </div>
      <div class="field" style="margin-bottom:10px;">
        <label>Новый пароль</label>
        <input type="password" id="newPasswordInput" autocomplete="new-password" placeholder="Минимум 6 символов">
      </div>
      <button class="btn-secondary" id="changePasswordBtn">Изменить пароль</button>
    </div>

    <div style="margin-top:24px;">
      <button class="btn-ghost" id="logoutBtn">${ICONS.logOut} Выйти из аккаунта</button>
    </div>
  `;
}

function bindProfile() {
  const backBtn = document.getElementById('backToRoomBtn');
  if (backBtn) backBtn.onclick = () => returnToRoom();

  const muteSwitch = document.getElementById('soundMuteSwitch');
  if (muteSwitch) muteSwitch.onclick = () => {
    const nextMuted = !Sound.isMuted();
    Sound.setMuted(nextMuted);
    muteSwitch.classList.toggle('on', !nextMuted);
    muteSwitch.setAttribute('aria-checked', String(!nextMuted));
    if (!nextMuted) Sound.click();
  };

  const sfxSlider = document.getElementById('sfxVolumeSlider');
  if (sfxSlider) sfxSlider.oninput = () => Sound.setSfxVolume(sfxSlider.value / 100);

  const musicSlider = document.getElementById('musicVolumeSlider');
  if (musicSlider) musicSlider.oninput = () => Sound.setMusicVolume(musicSlider.value / 100);

  const testBtn = document.getElementById('testSoundBtn');
  if (testBtn) testBtn.onclick = () => { Sound.setMuted(false); if (muteSwitch) { muteSwitch.classList.add('on'); muteSwitch.setAttribute('aria-checked', 'true'); } Sound.correct(); };

  document.getElementById('avatarFileInput').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { user } = await Api.uploadAvatar(file);
      state.user = user;
      render();
      showToast('Фото профиля обновлено');
    } catch (err) {
      showToast(err.message === 'bad_file_type' ? 'Разрешены только изображения' : 'Не удалось загрузить фото', ICONS.cross);
    }
  };

  const removeBtn = document.getElementById('removeAvatarBtn');
  if (removeBtn) removeBtn.onclick = async () => {
    try {
      const { user } = await Api.deleteAvatar();
      state.user = user;
      render();
      showToast('Фото удалено');
    } catch (err) {
      showToast('Не получилось удалить фото', ICONS.cross);
    }
  };

  document.getElementById('saveNameBtn').onclick = async () => {
    const val = document.getElementById('displayNameInput').value.trim();
    if (!val) { showToast('Имя не может быть пустым', ICONS.cross); return; }
    try {
      const { user } = await Api.updateProfile({ displayName: val });
      state.user = user;
      render();
      showToast('Имя обновлено');
    } catch (err) {
      showToast('Не получилось сохранить имя', ICONS.cross);
    }
  };

  document.querySelectorAll('#emojiGrid .emoji-opt').forEach((el) => {
    el.onclick = async () => {
      try {
        const { user } = await Api.updateProfile({ avatarEmoji: el.dataset.emoji });
        state.user = user;
        render();
      } catch (err) {
        showToast('Не получилось обновить аватар', ICONS.cross);
      }
    };
  });

  document.querySelectorAll('#colorGrid .color-opt').forEach((el) => {
    el.onclick = async () => {
      try {
        const { user } = await Api.updateProfile({ avatarColor: el.dataset.color });
        state.user = user;
        render();
      } catch (err) {
        showToast('Не получилось обновить цвет', ICONS.cross);
      }
    };
  });

  document.getElementById('changePasswordBtn').onclick = async () => {
    const currentPassword = document.getElementById('currentPasswordInput').value;
    const newPassword = document.getElementById('newPasswordInput').value;
    if (!newPassword || newPassword.length < 6) { showToast('Новый пароль минимум 6 символов', ICONS.cross); return; }
    try {
      await Api.changePassword(currentPassword, newPassword);
      showToast('Пароль изменён');
      document.getElementById('currentPasswordInput').value = '';
      document.getElementById('newPasswordInput').value = '';
    } catch (err) {
      showToast(err.code === 'wrong_password' ? 'Текущий пароль неверен' : 'Не получилось изменить пароль', ICONS.cross);
    }
  };

  document.getElementById('logoutBtn').onclick = () => logout();
}

/* ============ SETTINGS MODAL ============ */
function openSettings() {
  const overlay = document.getElementById('settingsOverlay');
  overlay.classList.add('open');
  renderThemeRow();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('closeSettings').onclick = () => {
    document.getElementById('settingsOverlay').classList.remove('open');
  };
  document.getElementById('settingsOverlay').onclick = (e) => {
    if (e.target.id === 'settingsOverlay') e.currentTarget.classList.remove('open');
  };

  document.getElementById('closeLeaveRoomModal').onclick = closeLeaveRoomConfirm;
  document.getElementById('stayInRoomBtn').onclick = closeLeaveRoomConfirm;
  document.getElementById('confirmLeaveRoomBtn').onclick = confirmLeaveRoom;
  document.getElementById('leaveRoomOverlay').onclick = (e) => {
    if (e.target.id === 'leaveRoomOverlay') closeLeaveRoomConfirm();
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('leaveRoomOverlay').classList.contains('open')) {
      closeLeaveRoomConfirm();
    }
    if (e.key === 'Escape' && document.getElementById('chatOverlay').classList.contains('open')) {
      closeChat();
    }
    if (e.key === 'Escape' && document.getElementById('profileOverlay').classList.contains('open')) {
      closePlayerProfile();
    }
  });

  document.getElementById('closeChatModal').onclick = closeChat;
  document.getElementById('chatOverlay').onclick = (e) => {
    if (e.target.id === 'chatOverlay') closeChat();
  };
  document.getElementById('chatSendBtn').onclick = sendChatMessage;
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });

  document.getElementById('closeProfileModal').onclick = closePlayerProfile;
  document.getElementById('profileOverlay').onclick = (e) => {
    if (e.target.id === 'profileOverlay') closePlayerProfile();
  };
});

// Closing/reloading the tab mid-room is just as easy to do by accident as clicking home,
// and it's the one exit path a confirm modal can't intercept — so this uses the browser's
// own native "leave site?" prompt instead.
window.addEventListener('beforeunload', (e) => {
  if (ROOM_VIEWS.has(state.view) && state.room) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function renderThemeRow() {
  document.querySelectorAll('.theme-opt').forEach((opt) => {
    opt.classList.toggle('active', opt.dataset.themeChoice === state.theme);
    opt.onclick = () => {
      state.theme = opt.dataset.themeChoice;
      localStorage.setItem('quiz_theme', state.theme);
      applyTheme();
      renderThemeRow();
    };
  });
}

function renderKeyInputs() {
  document.querySelectorAll('.key-input').forEach((input) => {
    const idx = parseInt(input.dataset.keyIdx, 10);
    input.value = state.apiKeys[idx] || '';
    input.oninput = (e) => {
      state.apiKeys[idx] = e.target.value.trim();
      localStorage.setItem('quiz_groq_keys', JSON.stringify(state.apiKeys));
      updateKeyStatuses();
    };
  });
  updateKeyStatuses();
}

function updateKeyStatuses() {
  const validKeys = getValidLocalKeys();
  document.querySelectorAll('.key-status').forEach((dot) => {
    const idx = parseInt(dot.dataset.keyStatus, 10);
    const hasValue = !!(state.apiKeys[idx] || '').trim();
    dot.classList.remove('filled', 'active', 'exhausted');
    if (!hasValue) return;
    const keyValue = state.apiKeys[idx].trim();
    const activeKeyValue = validKeys[state.activeKeyIndex];
    if (state.exhaustedKeys && state.exhaustedKeys.has(keyValue)) dot.classList.add('exhausted');
    else if (keyValue === activeKeyValue) dot.classList.add('active');
    else dot.classList.add('filled');
  });
}

/* ============ LOCAL (SOLO) GROQ CALLS ============ */
function getValidLocalKeys() {
  return state.apiKeys.map((k) => (k || '').trim()).filter(Boolean);
}

/* ---------------- Web access tools (solo mode, browser-side) ----------------
 * Same no-API-key approach as the server: DuckDuckGo's HTML endpoint, then
 * r.jina.ai as a CORS proxy fallback, then DDG Instant Answer JSON. Runs
 * right here in the browser since solo mode calls Groq directly with the
 * player's own key — no backend involved. */
function compactTextLocal(value, limit = 220) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function unwrapDdgHrefLocal(href) {
  const match = String(href || '').match(/[?&]uddg=([^&]+)/);
  if (match) { try { return decodeURIComponent(match[1]); } catch {} }
  return href || '';
}
function parseDdgHtmlLocal(html, maxResults) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const results = [];
  doc.querySelectorAll('.result').forEach((el) => {
    if (results.length >= maxResults) return;
    const link = el.querySelector('.result__a');
    if (!link) return;
    const url = unwrapDdgHrefLocal(link.getAttribute('href'));
    if (!/^https?:\/\//i.test(url)) return;
    results.push({ title: compactTextLocal(link.textContent, 100), url, snippet: compactTextLocal(el.querySelector('.result__snippet')?.textContent) });
  });
  return results;
}
function parseJinaMarkdownLocal(markdown, maxResults) {
  const results = [];
  const seen = new Set();
  const lines = String(markdown || '').split(/\r?\n/);
  for (let i = 0; i < lines.length && results.length < maxResults; i++) {
    const match = lines[i].match(/^\s*#{1,3}\s+\[(.+?)\]\((https?:\/\/[^)]+)\)/);
    if (!match) continue;
    const url = unwrapDdgHrefLocal(match[2]);
    if (!/^https?:\/\//i.test(url) || /duckduckgo\.com/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({ title: compactTextLocal(match[1], 100), url, snippet: '' });
  }
  return results;
}
async function webSearchLocal(query, maxResults = 4) {
  const clean = String(query || '').trim().slice(0, 240);
  if (!clean) return { ok: false, error: 'empty_query', results: [] };
  const timeoutFetchLocal = async (url, accept, ms = 7000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try { return await fetch(url, { headers: { Accept: accept }, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  };
  try {
    try {
      const direct = await timeoutFetchLocal(`https://duckduckgo.com/html/?q=${encodeURIComponent(clean)}`, 'text/html');
      if (direct.ok) {
        const results = parseDdgHtmlLocal(await direct.text(), maxResults);
        if (results.length) return { ok: true, results };
      }
    } catch {}
    try {
      const proxied = await timeoutFetchLocal(`https://r.jina.ai/http://duckduckgo.com/html/?q=${encodeURIComponent(clean)}`, 'text/plain');
      if (proxied.ok) {
        const results = parseJinaMarkdownLocal(await proxied.text(), maxResults);
        if (results.length) return { ok: true, results };
      }
    } catch {}
    return { ok: false, error: 'no_results', results: [] };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), results: [] };
  }
}
async function webFetchLocal(url, maxChars = 1600) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'invalid_url', text: '' };
  try {
    let res;
    try { res = await fetch(target, { headers: { Accept: 'text/html' } }); if (!res.ok) throw new Error('bad'); }
    catch { res = await fetch(`https://r.jina.ai/${target}`, { headers: { Accept: 'text/plain' } }); }
    const type = res.headers.get('content-type') || '';
    let text = await res.text();
    if (!/json|text\/plain/i.test(type)) {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      doc.querySelectorAll('script,style,nav,footer,noscript,svg').forEach((el) => el.remove());
      text = doc.body?.textContent || '';
    }
    text = compactTextLocal(text, maxChars);
    return text ? { ok: true, text } : { ok: false, error: 'empty_page', text: '' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), text: '' };
  }
}
const WEB_TOOL_SCHEMAS_LOCAL = [
  { type: 'function', function: { name: 'web_search', description: 'Search the live web for current, real-world facts (2026 data, recent events, exact figures, names, dates). Returns a short list of {title, url, snippet}.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Fetch a specific URL and return its readable plain-text content.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
];

async function callGroqWithKeyLocal(key, messages, jsonMode, useWebTools) {
  const body = { model: 'openai/gpt-oss-120b', messages, temperature: 0.85, max_tokens: 4000 };
  // json_object and tools are mutually exclusive on a tool-enabled turn — forcing
  // strict JSON would prevent the model from ever emitting a tool_call.
  if (jsonMode && !useWebTools) body.response_format = { type: 'json_object' };
  if (useWebTools) { body.tools = WEB_TOOL_SCHEMAS_LOCAL; body.tool_choice = 'auto'; }

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error('Groq API: ' + res.status + ' ' + errText.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.choices[0].message;
}

// Runs the tool-use loop for one key: the model may call web_search/web_fetch a
// few times before its final content. onStep, if given, reports each real call
// (no source links — just what's happening) so the UI can show live progress.
async function callGroqWithToolsForKeyLocal(key, initialMessages, jsonMode, useWebTools, onStep, maxToolTurns = 4) {
  const messages = [...initialMessages];
  if (useWebTools) {
    for (let turn = 0; turn < maxToolTurns; turn++) {
      const message = await callGroqWithKeyLocal(key, messages, jsonMode, true);
      if (!message.tool_calls || !message.tool_calls.length) return message.content;
      messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
        let result;
        if (call.function?.name === 'web_search') {
          onStep?.('search', args.query || '');
          result = await webSearchLocal(args.query || '', 4);
          onStep?.('search_done', { ok: result.ok, count: result.results?.length || 0 });
        } else if (call.function?.name === 'web_fetch') {
          onStep?.('fetch');
          result = await webFetchLocal(args.url || '');
          onStep?.('fetch_done', { ok: result.ok });
        } else {
          result = { ok: false, error: 'unknown_tool' };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
  }
  const final = await callGroqWithKeyLocal(key, messages, jsonMode, false);
  return final.content;
}

async function callGroqLocal(messages, jsonMode, onWait, useWebTools, onStep) {
  const keys = getValidLocalKeys();
  if (!keys.length) throw new Error('no-keys');

  let lastErr = null;
  const startIdx = Math.min(state.activeKeyIndex, keys.length - 1);
  const maxWaitRetries = keys.length === 1 ? 4 : 1;

  for (let i = 0; i < keys.length; i++) {
    const idx = (startIdx + i) % keys.length;
    for (let attempt = 0; attempt < maxWaitRetries; attempt++) {
      try {
        const result = await callGroqWithToolsForKeyLocal(keys[idx], messages, jsonMode, useWebTools, onStep);
        state.activeKeyIndex = idx;
        state.exhaustedKeys.delete(keys[idx]);
        updateKeyStatuses();
        return result;
      } catch (err) {
        lastErr = err;
        if (err.status === 429) {
          state.exhaustedKeys.add(keys[idx]);
          updateKeyStatuses();
          if (keys.length === 1 && attempt < maxWaitRetries - 1) {
            if (onWait) onWait(attempt + 1);
            await sleep(1500 * (attempt + 1));
            continue;
          }
          break;
        }
        if (err.status === 401 || err.status === 403) {
          state.exhaustedKeys.add(keys[idx]);
          updateKeyStatuses();
          break;
        }
        if (attempt < maxWaitRetries - 1) { await sleep(800); continue; }
        break;
      }
    }
  }
  throw lastErr || new Error('all-keys-failed');
}

function extractJsonLocal(raw) {
  let cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const startArr = cleaned.indexOf('[');
  let s = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
  if (s > 0) cleaned = cleaned.slice(s);
  return JSON.parse(cleaned);
}

// Turns a real tool-use step (search/fetch, no source links) into a short status
// line matching the room-mode phrasing, so solo and multiplayer read the same way.
function soloGenStepLabel(type, data) {
  switch (type) {
    case 'search': {
      const q = (data || '').length > 40 ? data.slice(0, 40) + '…' : (data || '');
      return `Ищу в интернете: «${q}»...`;
    }
    case 'search_done':
      return data?.ok ? `Нашёл ${data.count} результат(ов), читаю их...` : 'Поиск не удался, пробую иначе...';
    case 'fetch':
      return 'Открываю страницу для проверки...';
    case 'fetch_done':
      return 'Страница прочитана, разбираю данные...';
    default:
      return null;
  }
}

async function generateQuestionsDirectLegacy(topic, language, count, onProgress, ageGroup) {
  const batchSize = 4;
  const maxAttempts = 5;
  let all = [];
  const ageHint = AGE_PROMPT_HINTS[ageGroup] || AGE_PROMPT_HINTS.any;

  for (let attempt = 0; attempt < maxAttempts && all.length < count; attempt++) {
    const remaining = Math.min(batchSize, count - all.length);
    const askFor = Math.min(batchSize, remaining + 2);
    onProgress(all.length, count, 'Придумываю вопросы: «' + topic + '»');

    const sys = `Ты генератор вопросов для викторины. Сегодня 2026 год, и у тебя есть доступ к живому вебу через web_search и web_fetch — используй их, если тема требует актуальных на 2026 год фактов, точных цифр, дат, составов, версий или другой информации, в которой ты не уверен на 100% по памяти. Не изобретай факты, которые проще проверить одним поиском.
Когда закончишь (или если поиск не понадобился), отвечай ТОЛЬКО валидным JSON без пояснений, без markdown, в формате:
{"questions": [{"question": "текст вопроса", "options": ["вариант1","вариант2","вариант3","вариант4"], "correct": 0}]}
correct — индекс правильного варианта (0-3). Вопросы должны быть на языке: ${language}. Тема: ${topic}. Разнообразные, интересные, без повторов, средней сложности. ${ageHint}
КРИТИЧЕСКИ ВАЖНО: используй только реальные, проверяемые факты, при необходимости — сверенные через web_search/web_fetch. Если не уверен в точной цифре, дате, статистике или имени даже после проверки — не придумывай их и не включай такой вопрос. Не выдумывай данные, которых нет в реальности (несуществующие матчи, трансферы, рекорды, персонажей, игровые предметы и т.п. — если тема про конкретную игру, используй только то, что реально существует в этой игре).`;

    const userMsg = `Сгенерируй ${askFor} новых вопросов по теме "${topic}" на языке ${language}. Не повторяй уже использованные формулировки: ${all.map((q) => q.question).join(' | ').slice(0, 800)}`;

    let raw;
    try {
      raw = await callGroqLocal(
        [{ role: 'system', content: sys }, { role: 'user', content: userMsg }],
        true,
        (waitAttempt) => onProgress(all.length, count, 'Лимит запросов, жду ' + waitAttempt + '/3...'),
        true, // web tools on
        (type, data) => {
          const label = soloGenStepLabel(type, data);
          if (label) onProgress(all.length, count, label);
        }
      );
    } catch (e) {
      // A single failed call (rate limit, transient network) shouldn't end
      // generation outright — let the attempt cap decide, not one hiccup.
      if (e && e.message === 'no-keys') throw e; // no point retrying with no keys at all
      onProgress(Math.min(all.length, count), count, 'Придумываю вопросы: «' + topic + '»');
      continue;
    }

    let parsed;
    try { parsed = extractJsonLocal(raw); } catch (e) { parsed = { questions: [] }; }
    const qs = (parsed.questions || []).filter((q) => q.question && Array.isArray(q.options) && q.options.length >= 2);
    all = all.concat(qs);
    onProgress(Math.min(all.length, count), count, 'Придумываю вопросы: «' + topic + '»');
  }

  return all.slice(0, count);
}

async function generateTodPromptDirectLegacy(type, language, ageGroup, interest, onProgress) {
  const ageHint = AGE_PROMPT_HINTS[ageGroup] || AGE_PROMPT_HINTS.any;
  const interestHint = interest ? ` Учитывай интерес участников: ${interest}.` : '';
  const sys = `Ты генератор для игры "Правда или действие". Отвечай ТОЛЬКО JSON: {"text": "..."}. Язык: ${language}. ${type === 'truth' ? 'Придумай интересный, немного дерзкий, но безобидный вопрос для правды.' : 'Придумай весёлое, лёгкое в исполнении действие/задание.'} Не повторяйся, будь оригинальным. ${ageHint}${interestHint}`;
  try {
    if (onProgress) onProgress(1, 4, 'Отправляю запрос...');
    const raw = await callGroqLocal(
      [{ role: 'system', content: sys }, { role: 'user', content: type === 'truth' ? 'Вопрос для правды' : 'Задание для действия' }],
      true,
      (attempt) => { if (onProgress) onProgress(1, 4, 'Лимит запросов, жду... (' + attempt + '/4)'); }
    );
    if (onProgress) onProgress(3, 4, 'Разбираю ответ...');
    const result = extractJsonLocal(raw).text;
    if (onProgress) onProgress(4, 4, 'Готово');
    return result;
  } catch (e) {
    if (onProgress) onProgress(4, 4, 'Готово');
    return type === 'truth' ? 'Какой твой самый нелепый страх?' : 'Изобрази своё животное на выбор без слов.';
  }
}

// Solo generation goes through our server. That keeps the shared provider key
// out of the browser; an optional personal key is sent only with this request.
async function generateQuestionsLocal(topic, language, count, onProgress, ageGroup) {
  onProgress(0, count, state.exactFacts ? 'Ищу проверяемые даты и числа…' : 'Готовлю вопросы…');
  const result = await Api.generateSoloQuestions({
    topic,
    language,
    count,
    ageGroup,
    apiKey: state.generatorKey,
    exactFacts: state.exactFacts,
  });
  const questions = Array.isArray(result.questions) ? result.questions : [];
  onProgress(questions.length, count, questions.length ? 'Готово' : 'Не удалось подготовить вопросы');
  return questions;
}

async function generateTodPromptLocal(type, language, ageGroup, interest, onProgress) {
  if (onProgress) onProgress(1, 4, 'Готовлю карточку…');
  const result = await Api.generateTodPrompt({ type, language, ageGroup, interest, apiKey: state.generatorKey });
  if (onProgress) onProgress(4, 4, 'Готово');
  return result.text;
}

/* ============ SOLO SETUP ============ */
function setupHTML() {
  const isBlitz = state.setupMode === 'blitz';
  return `
    <div class="panel view" style="padding:24px;">
      <div class="mode-title" style="font-size:18px; margin-bottom:20px; display:flex; align-items:center; gap:9px;">
        ${isBlitz ? ICONS.bolt : ICONS.book}
        ${isBlitz ? 'Настройка блица' : 'Настройка классики'}
      </div>

      <div class="field">
        <label>Тема</label>
        <div class="chip-row" id="topicChips">
          ${TOPIC_PRESETS.map((t) => `<div class="chip ${state.selectedTopic === t ? 'active' : ''}" data-topic="${t}">${t}</div>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>Своя тема (необязательно)</label>
        <input type="text" id="customTopicInput" placeholder="Например: аниме девяностых" value="${escapeHtml(state.customTopic)}">
      </div>

      <div class="field">
        <label>Возраст участников</label>
        <div class="chip-row" id="ageChips">
          ${AGE_GROUPS.map((a) => `<div class="chip ${state.ageGroup === a.id ? 'active' : ''}" data-age="${a.id}">${a.label}</div>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>Язык вопросов</label>
        <select id="languageSelect">
          ${LANGUAGES.map((l) => `<option ${state.language === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>

      <div class="field">
        <button class="fact-toggle ${state.exactFacts ? 'active' : ''}" type="button" id="exactFactsToggle" aria-pressed="${state.exactFacts}">
          <span class="fact-toggle-mark">${state.exactFacts ? '✓' : ''}</span>
          <span><strong>Точные факты</strong><small>Вопросы с проверяемыми датами и числами</small></span>
        </button>
      </div>

      <div class="field">
        <label for="generatorKeyInput">Свой ключ генератора <span class="label-optional">необязательно</span></label>
        <input type="password" id="generatorKeyInput" autocomplete="off" spellcheck="false" placeholder="gsk_…" value="${escapeHtml(state.generatorKey)}">
        <div class="field-hint">Основной ключ уже защищённо подключён на сервере. Введённый сюда ключ не сохраняется.</div>
      </div>

      <div class="field">
        <label>${isBlitz ? 'Длительность раунда' : 'Количество вопросов'}</label>
        <div class="chip-row" id="countChips">
          ${isBlitz
            ? [30, 60, 90, 120].map((s) => `<div class="chip ${state.blitzSeconds === s ? 'active' : ''}" data-seconds="${s}">${s} сек</div>`).join('')
            : [5, 8, 12, 16].map((c) => `<div class="chip ${state.questionCount === c ? 'active' : ''}" data-count="${c}">${c}</div>`).join('')
          }
        </div>
      </div>

      ${!isBlitz ? `
      <div class="field">
        <div class="sound-toggle-row">
          <span>${ICONS.clock} Таймер на вопрос</span>
          <button class="switch ${state.perQuestionTimerEnabled ? 'on' : ''}" id="perQuestionTimerSwitch" role="switch" aria-checked="${state.perQuestionTimerEnabled}"><span class="switch-knob"></span></button>
        </div>
        <div class="chip-row" id="perQuestionSecondsChips" style="margin-top:10px; ${state.perQuestionTimerEnabled ? '' : 'opacity:0.4; pointer-events:none;'}">
          ${[10, 15, 20, 30].map((s) => `<div class="chip ${state.perQuestionSeconds === s ? 'active' : ''}" data-seconds="${s}">${s} сек</div>`).join('')}
        </div>
      </div>
      ` : ''}

      <button class="btn-primary" id="startBtn">${ICONS.arrowRight} Сгенерировать и начать</button>
    </div>
  `;
}

function bindSetup() {
  document.querySelectorAll('#ageChips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.ageGroup = chip.dataset.age;
      document.querySelectorAll('#ageChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    };
  });

  document.querySelectorAll('#topicChips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.selectedTopic = chip.dataset.topic;
      state.customTopic = '';
      document.getElementById('customTopicInput').value = '';
      document.querySelectorAll('#topicChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    };
  });

  document.getElementById('customTopicInput').oninput = (e) => {
    state.customTopic = e.target.value;
    if (e.target.value) {
      state.selectedTopic = '';
      document.querySelectorAll('#topicChips .chip').forEach((c) => c.classList.remove('active'));
    }
  };

  document.getElementById('languageSelect').onchange = (e) => { state.language = e.target.value; };

  document.getElementById('exactFactsToggle').onclick = () => {
    state.exactFacts = !state.exactFacts;
    const toggle = document.getElementById('exactFactsToggle');
    toggle.classList.toggle('active', state.exactFacts);
    toggle.setAttribute('aria-pressed', String(state.exactFacts));
    toggle.querySelector('.fact-toggle-mark').textContent = state.exactFacts ? '✓' : '';
  };
  document.getElementById('generatorKeyInput').oninput = (e) => { state.generatorKey = e.target.value.trim(); };

  document.querySelectorAll('#countChips .chip').forEach((chip) => {
    chip.onclick = () => {
      if (chip.dataset.count) state.questionCount = parseInt(chip.dataset.count, 10);
      if (chip.dataset.seconds) state.blitzSeconds = parseInt(chip.dataset.seconds, 10);
      document.querySelectorAll('#countChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    };
  });

  const timerSwitch = document.getElementById('perQuestionTimerSwitch');
  if (timerSwitch) timerSwitch.onclick = () => {
    state.perQuestionTimerEnabled = !state.perQuestionTimerEnabled;
    timerSwitch.classList.toggle('on', state.perQuestionTimerEnabled);
    timerSwitch.setAttribute('aria-checked', String(state.perQuestionTimerEnabled));
    const secondsRow = document.getElementById('perQuestionSecondsChips');
    if (secondsRow) secondsRow.style.opacity = state.perQuestionTimerEnabled ? '1' : '0.4';
    if (secondsRow) secondsRow.style.pointerEvents = state.perQuestionTimerEnabled ? 'auto' : 'none';
    Sound.click();
  };
  document.querySelectorAll('#perQuestionSecondsChips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.perQuestionSeconds = parseInt(chip.dataset.seconds, 10);
      document.querySelectorAll('#perQuestionSecondsChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    };
  });

  document.getElementById('startBtn').onclick = async () => {
    const topic = state.customTopic.trim() || state.selectedTopic;
    if (!topic) { showToast('Выбери или введи тему', ICONS.tag); return; }
    state.view = 'generating';
    render();
    try {
      const count = state.setupMode === 'blitz' ? 30 : state.questionCount;
      const qs = await generateQuestionsLocal(topic, state.language, count, (done, total, label) => {
        state.genProgress = done;
        state.genTotal = total;
        updateGenProgress(label);
      }, state.ageGroup);
      if (!qs.length) throw new Error('empty');
      state.questions = qs;
      state.currentIndex = 0;
      state.score = 0;
      state.answered = null;
      playRoundStartSequence(() => {
        state.view = 'quiz';
        render();
        Sound.startMusic();
        if (state.setupMode === 'blitz') startBlitzTimer();
        else if (state.perQuestionTimerEnabled) startPerQuestionTimer();
      });
    } catch (err) {
      console.error('Ошибка генерации вопросов:', err);
      let msg = 'Не удалось сгенерировать вопросы';
      if (err && err.message === 'no-keys') msg = 'Не указан ключ Groq API';
      else if (err && err.status === 401) msg = 'Groq: ключ недействителен (401)';
      else if (err && err.status === 403) msg = 'Groq: доступ запрещён (403)';
      else if (err && err.status === 429) msg = 'Groq: лимит запросов исчерпан (429)';
      else if (err && (err.code === 'timeout' || err.code === 'generation_timeout')) msg = 'Генерация заняла слишком много времени. Попробуй ещё раз';
      else if (err && err.message && err.status >= 500) msg = err.message;
      else if (err && err.status) msg = 'Groq вернул ошибку ' + err.status;
      else if (err && /fetch|network|Failed to fetch/i.test(err.message || '')) msg = 'Нет сети / запрос к api.groq.com заблокирован';
      showToast(msg, ICONS.cross);
      state.view = 'setup';
      render();
    }
  };
}

/* ============ GENERATING ============ */
function generatingHTML() {
  const pct = state.genTotal ? Math.round((state.genProgress / state.genTotal) * 100) : 0;
  const circumference = 2 * Math.PI * 44;
  const offset = circumference - (pct / 100) * circumference;
  return `
    <div class="panel gen-wrap view">
      <div class="gen-ring-wrap">
        <svg viewBox="0 0 100 100">
          <circle class="gen-ring-bg" cx="50" cy="50" r="44" fill="none" stroke-width="7"/>
          <circle class="gen-ring-fg" id="genRingFg" cx="50" cy="50" r="44" fill="none" stroke-width="7"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>
        </svg>
        <div class="gen-percent" id="genPercentText">${pct}%</div>
      </div>
      <div class="gen-status" id="genStatusText">Готовлю вопросы...</div>
      <div class="gen-sub">Подбираю формулировки и варианты ответов</div>
    </div>
  `;
}

function updateGenProgress(label) {
  const pct = state.genTotal ? Math.round((state.genProgress / state.genTotal) * 100) : 0;
  const circumference = 2 * Math.PI * 44;
  const offset = circumference - (pct / 100) * circumference;
  const ring = document.getElementById('genRingFg');
  const percentText = document.getElementById('genPercentText');
  const statusText = document.getElementById('genStatusText');
  if (ring) ring.style.strokeDashoffset = offset;
  if (percentText) percentText.textContent = pct + '%';
  if (statusText) statusText.textContent = label;
}

/* ============ SOLO QUIZ ============ */
function quizHTML() {
  const q = state.questions[state.currentIndex];
  const total = state.setupMode === 'blitz' ? '∞' : state.questions.length;
  const progressPct = state.setupMode === 'blitz' ? 100 : Math.round(((state.currentIndex) / state.questions.length) * 100);
  const showClassicTimer = state.setupMode !== 'blitz' && state.perQuestionTimerEnabled;
  return `
    <div class="quiz-topline">
      <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>
      ${state.setupMode === 'blitz'
        ? `<span class="timer-badge" id="timerBadge">${ICONS.clock} ${state.timeLeft}с</span>`
        : showClassicTimer
          ? `<span class="timer-badge" id="timerBadge">${ICONS.clock} ${state.timeLeft}с</span><span class="quiz-counter">${state.currentIndex + 1} / ${total}</span>`
          : `<span class="quiz-counter">${state.currentIndex + 1} / ${total}</span>`
      }
      <span class="score-badge">${ICONS.trophy} ${state.score}</span>
    </div>
    <div class="panel question-card view">
      <div class="question-category">${ICONS.tag} ${escapeHtml(state.customTopic.trim() || state.selectedTopic || 'Викторина')}</div>
      <div class="question-text">${escapeHtml(q.question)}</div>
    </div>
    <div class="answers-grid">
      ${q.options.map((opt, i) => `
        <button class="answer-btn" data-idx="${i}">
          <span style="display:flex; align-items:center; gap:11px;">
            <span class="answer-letter">${String.fromCharCode(65 + i)}</span>
            <span>${escapeHtml(opt)}</span>
          </span>
          <span class="answer-check">${ICONS.check}</span>
        </button>
      `).join('')}
    </div>
  `;
}

function bindQuiz() {
  document.querySelectorAll('.answer-btn').forEach((btn, i) => {
    btn.style.setProperty('--stagger', i);
    btn.onclick = () => selectAnswer(parseInt(btn.dataset.idx, 10));
  });
}

function selectAnswer(idx) {
  if (state.answered !== null) return;
  stopTimer();
  Sound.click();
  const q = state.questions[state.currentIndex];
  state.answered = idx;
  const correct = q.correct;

  document.querySelectorAll('.answer-btn').forEach((btn, i) => {
    btn.disabled = true;
    if (i === correct) btn.classList.add('correct');
    else if (i === idx) btn.classList.add('wrong');
  });

  if (idx === correct) {
    Sound.correct();
    state.score++;
    const scoreBadge = document.querySelector('.score-badge');
    if (scoreBadge) { scoreBadge.innerHTML = ICONS.trophy + ' ' + state.score; scoreBadge.classList.remove('bump'); void scoreBadge.offsetWidth; scoreBadge.classList.add('bump'); }
  } else {
    Sound.wrong();
  }

  setTimeout(() => nextQuestion(), 1100);
}

function nextQuestion() {
  if (state.currentIndex + 1 >= state.questions.length) { finishQuiz(); return; }
  state.currentIndex++;
  state.answered = null;
  const main = document.getElementById('appMain');
  main.innerHTML = quizHTML();
  bindQuiz();
  if (state.setupMode !== 'blitz' && state.perQuestionTimerEnabled) startPerQuestionTimer();
}

function startBlitzTimer() {
  state.timeLeft = state.blitzSeconds;
  stopTimer();
  state.timerInterval = setInterval(() => {
    state.timeLeft--;
    const badge = document.getElementById('timerBadge');
    const fill = document.querySelector('.progress-fill');
    if (badge) {
      badge.innerHTML = ICONS.clock + ' ' + state.timeLeft + 'с';
      badge.classList.toggle('warn', state.timeLeft <= 10);
    }
    if (fill) fill.style.width = Math.round((state.timeLeft / state.blitzSeconds) * 100) + '%';
    if (state.timeLeft <= 3 && state.timeLeft > 0) Sound.tick(false);
    if (state.timeLeft <= 0) { stopTimer(); finishQuiz(); }
  }, 1000);
}

// Classic-mode per-question countdown: unlike blitz, hitting zero doesn't end
// the quiz — it just locks the question as unanswered and advances, same as
// the multiplayer room's question deadline.
function startPerQuestionTimer() {
  state.timeLeft = state.perQuestionSeconds;
  stopTimer();
  state.timerInterval = setInterval(() => {
    state.timeLeft--;
    const badge = document.getElementById('timerBadge');
    if (badge) {
      badge.innerHTML = ICONS.clock + ' ' + state.timeLeft + 'с';
      badge.classList.toggle('warn', state.timeLeft <= 5);
    }
    if (state.timeLeft <= 3 && state.timeLeft > 0) Sound.tick(state.timeLeft === 1);
    if (state.timeLeft <= 0) {
      stopTimer();
      if (state.answered === null) {
        state.answered = -1;
        Sound.wrong();
        document.querySelectorAll('.answer-btn').forEach((btn, i) => {
          btn.disabled = true;
          if (i === state.questions[state.currentIndex].correct) btn.classList.add('correct');
        });
        setTimeout(() => nextQuestion(), 900);
      }
    }
  }, 1000);
}

function stopTimer() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
}

function finishQuiz() {
  stopTimer();
  Sound.stopMusic();
  state.view = 'result';
  render();
}

/* ============ SOLO RESULT ============ */
function resultHTML() {
  const total = state.setupMode === 'blitz' ? (state.currentIndex + 1) : state.questions.length;
  const pct = total ? Math.round((state.score / total) * 100) : 0;
  const circumference = 2 * Math.PI * 52;

  let title, sub;
  if (pct >= 90) { title = 'Безупречно'; sub = 'Почти все ответы верные — впечатляющий результат.'; }
  else if (pct >= 70) { title = 'Очень достойно'; sub = 'Хорошее знание темы, есть куда расти.'; }
  else if (pct >= 40) { title = 'Неплохое начало'; sub = 'Часть вопросов оказалась с подвохом.'; }
  else { title = 'Есть над чем поработать'; sub = 'Попробуй ещё раз с той же темой.'; }

  return `
    <div class="panel result-hero view">
      <div class="result-ring">
        <svg viewBox="0 0 120 120">
          <circle class="result-ring-bg" cx="60" cy="60" r="52" fill="none" stroke-width="9"/>
          <circle class="result-ring-fg" id="resultRingFg" cx="60" cy="60" r="52" fill="none" stroke-width="9"
            stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}"/>
        </svg>
        <div class="result-percent">
          <div class="num" id="resultNum">0/${total}</div>
          <div class="lbl">верных</div>
        </div>
      </div>
      <div class="result-title">${title}</div>
      <div class="result-sub">${sub}</div>
      <div class="result-actions">
        <button class="btn-ghost" id="retryBtn">${ICONS.refresh} Ещё раз</button>
        <button class="btn-ghost" id="homeBtn">${ICONS.home} На главную</button>
      </div>
    </div>
  `;
}

function bindResult() {
  document.getElementById('retryBtn').onclick = () => { state.view = 'setup'; render(); };
  document.getElementById('homeBtn').onclick = () => goHome();

  const total = state.setupMode === 'blitz' ? (state.currentIndex + 1) : state.questions.length;
  const pct = total ? Math.round((state.score / total) * 100) : 0;
  const circumference = 2 * Math.PI * 52;
  const targetOffset = circumference - (pct / 100) * circumference;

  requestAnimationFrame(() => {
    const ring = document.getElementById('resultRingFg');
    if (ring) ring.style.strokeDashoffset = targetOffset;
  });

  const numEl = document.getElementById('resultNum');
  if (numEl && state.score > 0) {
    let current = 0;
    const step = () => {
      current++;
      numEl.textContent = current + '/' + total;
      if (current < state.score) requestAnimationFrame(step);
      else numEl.textContent = state.score + '/' + total;
    };
    requestAnimationFrame(step);
  }
}

/* ============ TRUTH OR DARE: SETUP ============ */
function todSetupHTML() {
  return `
    <div class="panel view" style="padding:24px;">
      <div class="mode-title" style="font-size:18px; margin-bottom:20px; display:flex; align-items:center; gap:9px;">
        ${ICONS.heart} Правда или действие
      </div>

      <div class="field">
        <label style="display:flex; align-items:center; justify-content:space-between;">
          <span>Групповой режим</span>
          <span class="chip ${state.groupMode ? 'active' : ''}" id="todGroupToggle" style="padding:5px 12px;">${state.groupMode ? 'Включён' : 'Выключен'}</span>
        </label>
      </div>

      ${state.groupMode ? `
      <div class="field">
        <label>Сколько человек играет</label>
        <div class="chip-row" id="todPlayerCountChips">
          ${[1, 2, 3, 4].map((n) => `<div class="chip ${state.playerCount === n ? 'active' : ''}" data-players="${n}">${n}</div>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Имена игроков</label>
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${Array.from({ length: state.playerCount }).map((_, i) => `
            <input type="text" class="tod-player-name-input" data-player-idx="${i}" placeholder="Игрок ${i + 1}" value="${escapeHtml(state.playerNames[i] || '')}">
          `).join('')}
        </div>
      </div>` : ''}

      <div class="field">
        <label>Возраст участников</label>
        <div class="chip-row" id="todAgeChips">
          ${AGE_GROUPS.map((a) => `<div class="chip ${state.ageGroup === a.id ? 'active' : ''}" data-age="${a.id}">${a.label}</div>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>Интерес (необязательно)</label>
        <div class="chip-row" id="todInterestChips">
          ${INTEREST_PRESETS.map((i) => `<div class="chip ${state.interest === i ? 'active' : ''}" data-interest="${i}">${i}</div>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>Язык</label>
        <select id="todLanguageSelect">
          ${LANGUAGES.map((l) => `<option ${state.language === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>

      <button class="btn-primary" id="todStartBtn">${ICONS.arrowRight} Начать игру</button>
    </div>
  `;
}

function bindTodSetup() {
  const groupToggle = document.getElementById('todGroupToggle');
  if (groupToggle) {
    groupToggle.onclick = () => {
      state.groupMode = !state.groupMode;
      if (state.groupMode && state.playerCount < 2) state.playerCount = 2;
      document.getElementById('appMain').innerHTML = todSetupHTML();
      bindTodSetup();
    };
  }

  document.querySelectorAll('#todPlayerCountChips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.playerCount = parseInt(chip.dataset.players, 10);
      while (state.playerNames.length < state.playerCount) state.playerNames.push('Игрок ' + (state.playerNames.length + 1));
      document.getElementById('appMain').innerHTML = todSetupHTML();
      bindTodSetup();
    };
  });

  document.querySelectorAll('.tod-player-name-input').forEach((input) => {
    input.oninput = (e) => { state.playerNames[parseInt(input.dataset.playerIdx, 10)] = e.target.value; };
  });

  document.querySelectorAll('#todAgeChips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.ageGroup = chip.dataset.age;
      document.querySelectorAll('#todAgeChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    };
  });

  document.querySelectorAll('#todInterestChips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.interest = state.interest === chip.dataset.interest ? '' : chip.dataset.interest;
      document.querySelectorAll('#todInterestChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.interest === state.interest));
    };
  });

  document.getElementById('todLanguageSelect').onchange = (e) => { state.language = e.target.value; };

  document.getElementById('todStartBtn').onclick = () => {
    state.currentPlayerIdx = 0;
    state.view = 'tod';
    render();
    loadTodCard('truth');
  };
}

/* ============ TRUTH OR DARE: GAME ============ */
function currentTodPlayerName() {
  if (!state.groupMode) return '';
  return state.playerNames[state.currentPlayerIdx] || ('Игрок ' + (state.currentPlayerIdx + 1));
}

function todTurnBannerHTML() {
  if (!state.groupMode) return '';
  return `<div class="quiz-counter" style="margin-bottom:12px; display:flex; align-items:center; gap:7px; justify-content:center;">${ICONS.users} Ходит: <strong>${escapeHtml(currentTodPlayerName())}</strong></div>`;
}

function todGeneratingHTML(done, total, label) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const circumference = 2 * Math.PI * 44;
  const offset = circumference - (pct / 100) * circumference;
  return `
    <div class="gen-ring-wrap">
      <svg viewBox="0 0 100 100">
        <circle class="gen-ring-bg" cx="50" cy="50" r="44" fill="none" stroke-width="7"/>
        <circle class="gen-ring-fg" id="todGenRingFg" cx="50" cy="50" r="44" fill="none" stroke-width="7"
          stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>
      </svg>
      <div class="gen-percent" id="todGenPercentText">${pct}%</div>
    </div>
    <div class="gen-status" id="todGenStatusText">${label}</div>
  `;
}

function updateTodGenProgress(done, total, label) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const circumference = 2 * Math.PI * 44;
  const offset = circumference - (pct / 100) * circumference;
  const ring = document.getElementById('todGenRingFg');
  const percentText = document.getElementById('todGenPercentText');
  const statusText = document.getElementById('todGenStatusText');
  if (ring) ring.style.strokeDashoffset = offset;
  if (percentText) percentText.textContent = pct + '%';
  if (statusText) statusText.textContent = label;
}

function todHTML() {
  return `
    ${todTurnBannerHTML()}
    <div class="panel tod-card gen-wrap view" id="todCard">
      ${todGeneratingHTML(0, 4, 'Придумываю карточку...')}
    </div>
  `;
}

function bindTod() {}

async function loadTodCard(type) {
  const card = document.getElementById('todCard');
  if (!card) return;
  card.innerHTML = todGeneratingHTML(0, 4, 'Придумываю карточку...');
  try {
    const text = await generateTodPromptLocal(type, state.language, state.ageGroup, state.interest, (done, total, label) => {
      if (state.view !== 'tod') return;
      updateTodGenProgress(done, total, label);
    });
    if (state.view !== 'tod') return;
    renderTodResult(type, text);
  } catch (e) {
    if (state.view !== 'tod') return;
    renderTodResult(type, type === 'truth' ? 'Какой твой самый нелепый детский страх?' : 'Спой одну строчку любимой песни вслух.');
  }
}

function renderTodResult(type, text) {
  const card = document.getElementById('todCard');
  if (!card) return;
  card.innerHTML = `
    <div class="tod-pill ${type}">${type === 'truth' ? ICONS.eye : ICONS.flame} ${type === 'truth' ? 'Правда' : 'Действие'}</div>
    <div class="tod-text">${escapeHtml(text)}</div>
    <div class="tod-choice-grid">
      <button class="tod-choice-btn truth-btn" id="pickTruth">${ICONS.eye} Правда</button>
      <button class="tod-choice-btn dare-btn" id="pickDare">${ICONS.flame} Действие</button>
    </div>
    ${state.groupMode ? `<button class="btn-ghost" id="nextTodPlayer" style="margin-top:12px; width:100%; justify-content:center;">${ICONS.arrowRight} Следующий игрок</button>` : ''}
  `;
  document.getElementById('pickTruth').onclick = () => loadTodCard('truth');
  document.getElementById('pickDare').onclick = () => loadTodCard('dare');
  const nextBtn = document.getElementById('nextTodPlayer');
  if (nextBtn) {
    nextBtn.onclick = () => {
      state.currentPlayerIdx = (state.currentPlayerIdx + 1) % state.playerCount;
      renderTodTurnTransition();
    };
  }
}

function renderTodTurnTransition() {
  const main = document.getElementById('appMain');
  main.innerHTML = todHTML();
  bindTod();
  loadTodCard('truth');
}

/* ============ ROOMS: CREATE ============ */
function roomCreateHTML() {
  const s = state.roomSetup;
  const isBlitz = s.mode === 'blitz';
  return `
    <div class="panel view" style="padding:24px;">
      <div class="mode-title" style="font-size:18px; margin-bottom:20px; display:flex; align-items:center; gap:9px;">
        ${ICONS.users} Новая комната
      </div>

      <div class="field">
        <label>Название лобби</label>
        <input type="text" id="roomNameInput" maxlength="60" placeholder="Например: Вечерняя викторина" value="${escapeHtml(s.name || '')}">
      </div>

      <div class="field">
        <label>Режим</label>
        <div class="chip-row" id="roomModeChips">
          <div class="chip ${!isBlitz ? 'active' : ''}" data-mode="classic">Классика</div>
          <div class="chip ${isBlitz ? 'active' : ''}" data-mode="blitz">Блиц</div>
        </div>
      </div>

      <div class="field">
        <label>Тема</label>
        <div class="chip-row" id="roomTopicChips">
          ${TOPIC_PRESETS.map((t) => `<div class="chip ${s.topic === t ? 'active' : ''}" data-topic="${t}">${t}</div>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>Своя тема (необязательно)</label>
        <input type="text" id="roomCustomTopic" placeholder="Например: сериалы 2020-х" value="${escapeHtml(s.customTopic || '')}">
      </div>

      <div class="field">
        <label>Язык вопросов</label>
        <select id="roomLanguageSelect">
          ${LANGUAGES.map((l) => `<option ${s.language === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>

      <div class="field">
        <label>Количество вопросов</label>
        <div class="chip-row" id="roomCountChips">
          ${[6, 10, 15, 20].map((c) => `<div class="chip ${s.questionCount === c ? 'active' : ''}" data-count="${c}">${c}</div>`).join('')}
        </div>
      </div>

      ${s.mode !== 'blitz' ? `
      <div class="field">
        <label>${ICONS.clock} Время на раунд</label>
        <div class="chip-row" id="roomQuestionSecondsChips">
          ${QUESTION_SECONDS_OPTIONS.map((sec) => `<div class="chip ${(s.questionSeconds || 20) === sec ? 'active' : ''}" data-seconds="${sec}">${sec} сек</div>`).join('')}
        </div>
        <div class="field-hint">Сколько времени игроки думают над каждым вопросом. Можно поменять позже в лобби.</div>
      </div>
      ` : ''}

      <div class="field">
        <label>Лимит игроков</label>
        <div class="chip-row" id="roomMaxPlayersChips">
          ${MAX_PLAYERS_OPTIONS.map((n) => `<div class="chip ${(s.maxPlayers || 0) === n ? 'active' : ''}" data-max="${n}">${n === 0 ? 'Без лимита' : n}</div>`).join('')}
        </div>
        <div class="field-hint">Можно поменять позже прямо в лобби.</div>
      </div>

      <div class="field">
        <label>${ICONS.lock} Пароль комнаты (необязательно)</label>
        <input type="text" id="roomPasswordInput" maxlength="40" placeholder="Оставь пустым, если вход свободный" value="${escapeHtml(s.password || '')}">
        <div class="field-hint">Если задан — комнату можно найти в списке, но зайти получится только с паролем.</div>
      </div>

      <button class="btn-primary" id="roomCreateBtn" ${state.roomBusy ? 'disabled' : ''}>
        ${state.roomBusy ? LOADER('inline') : ICONS.plus}
        Создать комнату
      </button>
    </div>
  `;
}

function bindRoomCreate() {
  document.querySelectorAll('#roomModeChips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.roomSetup.name = (document.getElementById('roomNameInput').value || '');
      state.roomSetup.mode = chip.dataset.mode;
      document.getElementById('appMain').innerHTML = roomCreateHTML();
      bindRoomCreate();
    };
  });

  document.querySelectorAll('#roomTopicChips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.roomSetup.topic = chip.dataset.topic;
      state.roomSetup.customTopic = '';
      document.getElementById('roomCustomTopic').value = '';
      document.querySelectorAll('#roomTopicChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    };
  });

  document.getElementById('roomCustomTopic').oninput = (e) => {
    state.roomSetup.customTopic = e.target.value;
    if (e.target.value) {
      state.roomSetup.topic = '';
      document.querySelectorAll('#roomTopicChips .chip').forEach((c) => c.classList.remove('active'));
    }
  };

  document.getElementById('roomLanguageSelect').onchange = (e) => { state.roomSetup.language = e.target.value; };

  document.querySelectorAll('#roomCountChips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.roomSetup.questionCount = parseInt(chip.dataset.count, 10);
      document.querySelectorAll('#roomCountChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    };
  });

  document.querySelectorAll('#roomQuestionSecondsChips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.roomSetup.questionSeconds = parseInt(chip.dataset.seconds, 10);
      document.querySelectorAll('#roomQuestionSecondsChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    };
  });

  document.querySelectorAll('#roomMaxPlayersChips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.roomSetup.maxPlayers = parseInt(chip.dataset.max, 10);
      document.querySelectorAll('#roomMaxPlayersChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    };
  });

  document.getElementById('roomCreateBtn').onclick = async () => {
    const s = state.roomSetup;
    const topic = (s.customTopic || '').trim() || s.topic;
    if (!topic) { showToast('Выбери или введи тему', ICONS.tag); return; }

    if (!state.user) {
      state.authMode = 'login';
      state.authError = 'Чтобы создать комнату, сначала войдите в аккаунт.';
      state.view = 'auth';
      render();
      return;
    }

    s.name = (document.getElementById('roomNameInput').value || '').trim();
    s.password = (document.getElementById('roomPasswordInput').value || '').trim();

    state.roomBusy = true;
    render();
    try {
      const { room } = await Api.createRoom({
        mode: s.mode,
        topic,
        language: s.language,
        questionCount: s.questionCount,
        questionSeconds: s.mode === 'blitz' ? undefined : (s.questionSeconds || 20),
        maxPlayers: s.maxPlayers || 0,
        password: s.password || '',
        name: s.name || topic,
        apiKey: state.generatorKey,
      });
      state.room = room;
      state.roomBusy = false;
      connectRoomSocket(room.code);
      state.view = 'roomLobby';
      render();
    } catch (err) {
      state.roomBusy = false;
      if (err.status === 401 || err.code === 'stale_session') {
        Api.setToken(null);
        state.user = null;
        state.authMode = 'login';
        state.authError = 'Сессия устарела после обновления сервера. Войдите заново.';
        state.view = 'auth';
        render();
        return;
      }
      showToast(
        err.network ? 'Не удалось связаться с сервером' : (err.message || 'Не получилось создать комнату'),
        ICONS.cross
      );
      render();
    }
  };
}

/* ============ ROOMS: JOIN ============ */
function roomJoinHTML() {
  return `
    <div class="panel view" style="padding:22px 24px 16px;">
      <div class="mode-title" style="font-size:18px; margin-bottom:4px; display:flex; align-items:center; gap:9px;">
        ${ICONS.users} Войти по коду
      </div>
      <div class="auth-sub" style="margin-bottom:14px;">Спроси код комнаты у того, кто её создал.</div>
      ${state.roomError ? `<div class="auth-error">${escapeHtml(state.roomError)}</div>` : ''}
      <form id="roomJoinForm" style="display:flex; gap:10px; align-items:flex-end;">
        <div class="field" style="flex:1; margin-bottom:0;">
          <input type="text" id="roomCodeInput" placeholder="Например, K7QX9" maxlength="8" style="text-transform:uppercase; letter-spacing:0.08em; font-weight:700;" autocomplete="off" required>
        </div>
        <button class="btn-primary" id="roomJoinBtn" type="submit" style="width:auto; padding:0 18px;" ${state.roomBusy ? 'disabled' : ''}>
          ${state.roomBusy ? LOADER('inline') : ICONS.arrowRight}
        </button>
      </form>
    </div>

    <div class="section-label" style="display:flex; justify-content:space-between; align-items:center;">
      <span>Открытые комнаты</span>
      <button class="btn-ghost" id="refreshRoomsBtn" style="padding:5px 10px; font-size:13px;">${ICONS.refresh || '↻'} Обновить</button>
    </div>
    <div id="browseRoomsWrap">${browseRoomsListHTML()}</div>
  `;
}

function browseRoomsListHTML() {
  if (state.browseRoomsLoading) {
    return `<div class="empty-state" style="padding:24px;">${LOADER('full')}</div>`;
  }
  if (state.browseRoomsError) {
    return `<div class="empty-state" style="padding:20px;"><div class="sub">${escapeHtml(state.browseRoomsError)}</div></div>`;
  }
  const rooms = state.browseRooms || [];
  if (!rooms.length) {
    return `<div class="empty-state" style="padding:20px;">${ICONS.users}<div class="sub">Открытых комнат сейчас нет. Создай свою или войди по коду.</div></div>`;
  }
  return `
    <div class="room-browse-list">
      ${rooms.map((r, i) => `
        <div class="panel room-browse-row" data-code="${escapeHtml(r.code)}" style="--stagger:${i}; animation: memberIn 0.26s cubic-bezier(0.16,1,0.3,1) both; animation-delay: calc(${i} * 0.05s);">
          <div class="room-browse-main">
            <div class="room-browse-name">${escapeHtml(r.name || r.topic)} ${r.hasPassword ? `<span class="room-lock-badge" title="Требуется пароль">${ICONS.lock}</span>` : ''}</div>
            <div class="room-browse-meta">
              <span class="chip" style="cursor:default;">${r.mode === 'blitz' ? 'Блиц' : 'Классика'}</span>
              <span class="room-browse-count">${ICONS.users} ${r.memberCount}${r.maxPlayers ? ' / ' + r.maxPlayers : ''}</span>
            </div>
            <div class="room-browse-avatars">
              ${r.members.map((m) => avatarHTML(m, 'sm')).join('')}
              ${r.memberCount > r.members.length ? `<span class="avatar sm room-browse-more">+${r.memberCount - r.members.length}</span>` : ''}
            </div>
          </div>
          <button class="btn-primary room-browse-join" data-code="${escapeHtml(r.code)}" style="width:auto; padding:0 16px;">
            ${ICONS.arrowRight} Войти
          </button>
        </div>
      `).join('')}
    </div>
  `;
}

async function loadBrowseRooms() {
  // Only show the loading state on the very first fetch (nothing on screen yet).
  // Background refreshes (polling, manual "Обновить") swap the list in place —
  // no flicker back to the loader while rooms are already showing.
  const isFirstLoad = state.browseRooms === null;
  if (isFirstLoad) {
    state.browseRoomsLoading = true;
    state.browseRoomsError = '';
    const wrap = document.getElementById('browseRoomsWrap');
    if (wrap) wrap.innerHTML = browseRoomsListHTML();
  }
  try {
    const { rooms } = await Api.browseRooms();
    state.browseRooms = rooms;
    state.browseRoomsError = '';
  } catch (err) {
    if (isFirstLoad) {
      state.browseRooms = [];
      state.browseRoomsError = err.network ? 'Не удалось связаться с сервером.' : 'Не получилось загрузить список комнат.';
    }
    // silent refreshes just keep showing the last known list on failure
  }
  state.browseRoomsLoading = false;
  const wrap2 = document.getElementById('browseRoomsWrap');
  if (wrap2) wrap2.innerHTML = browseRoomsListHTML();
  bindBrowseRoomsList();
}

function bindBrowseRoomsList() {
  document.querySelectorAll('.room-browse-join').forEach((btn) => {
    btn.onclick = () => {
      const room = (state.browseRooms || []).find((r) => r.code === btn.dataset.code);
      if (room && room.hasPassword) promptRoomPassword(btn.dataset.code);
      else joinRoomByCode(btn.dataset.code);
    };
  });
}

let roomPasswordOverlayOpen = false;

function promptRoomPassword(code, prefillError) {
  // Never stack a second password window — if one's already open for this
  // (or any) code, just refresh its error state instead of creating another.
  if (roomPasswordOverlayOpen) {
    const existing = document.querySelector('.room-password-overlay');
    if (existing) {
      const hint = existing.querySelector('.field-hint');
      const input = existing.querySelector('#roomPasswordPromptInput');
      if (hint) hint.textContent = prefillError || '';
      if (input) { input.value = ''; input.focus(); }
      return;
    }
  }
  state.pendingJoinCode = code;
  roomPasswordOverlayOpen = true;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay room-password-overlay';
  overlay.innerHTML = `
    <div class="panel modal-card">
      <div class="modal-title">${ICONS.lock} Комната защищена паролем</div>
      <div class="field" style="margin-top:6px;">
        <input type="password" id="roomPasswordPromptInput" autocomplete="current-password"
          inputmode="text" placeholder="Введите пароль">
        <div class="field-hint" style="color:var(--bad);">${prefillError ? escapeHtml(prefillError) : ''}</div>
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" id="roomPasswordCancel" style="width:auto; padding:8px 16px;">Отмена</button>
        <button class="btn-primary" id="roomPasswordSubmit" style="width:auto; padding:8px 18px;">${ICONS.arrowRight} Войти</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#roomPasswordPromptInput');
  const hint = overlay.querySelector('.field-hint');
  const button = overlay.querySelector('#roomPasswordSubmit');

  // Focus needs a tick on mobile (iOS/Android both drop a same-frame focus
  // call before the element has finished laying out), and again after fonts/
  // paint settle — asking twice costs nothing and guarantees the keyboard opens.
  input.focus();
  requestAnimationFrame(() => input.focus());
  setTimeout(() => input.focus(), 60);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    roomPasswordOverlayOpen = false;
    overlay.remove();
  };

  overlay.querySelector('#roomPasswordCancel').onclick = close;
  // Clicking the backdrop itself (not the card, not the input, not the keyboard)
  // still cancels — but never while a submit is in flight.
  overlay.onclick = (e) => { if (e.target === overlay && !submit._busy) close(); };
  // Stop clicks on the card/input from bubbling to the overlay and closing it.
  overlay.querySelector('.modal-card').onclick = (e) => e.stopPropagation();

  let submitted = false;
  async function submit() {
    if (submit._busy || submitted) return;
    submit._busy = true;
    input.disabled = true;
    button.disabled = true;
    button.innerHTML = LOADER('inline') + ' Проверяю пароль…';
    hint.textContent = '';

    const value = input.value;
    try {
      const { room } = await Api.joinRoom(code, value);
      submitted = true; // Enter/click can't double-fire once this flips
      state.room = room;
      state.roomBusy = false;
      close();
      connectRoomSocket(room.code);
      state.view = 'roomLobby';
      render();
    } catch (err) {
      submit._busy = false;
      input.disabled = false;
      button.disabled = false;
      button.innerHTML = ICONS.arrowRight + ' Войти';
      if (err.code === 'wrong_password') {
        hint.textContent = err.message || 'Неверный пароль.';
        input.value = '';
        input.focus();
        return; // window stays open, nothing else changes
      }
      close();
      state.roomError = roomErrorMessage(err);
      render();
    }
  }
  submit._busy = false;

  button.onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  };
}

async function joinRoomByCode(code, password) {
  if (!code) return;
  state.roomError = '';
  state.roomBusy = true;
  render();
  try {
    const { room } = await Api.joinRoom(code, password);
    state.room = room;
    state.roomBusy = false;
    connectRoomSocket(room.code);
    state.view = 'roomLobby';
    render();
  } catch (err) {
    state.roomBusy = false;
    if (err.code === 'wrong_password') {
      render();
      promptRoomPassword(code, err.message || 'Неверный пароль.');
      return;
    }
    state.roomError = roomErrorMessage(err);
    render();
  }
}

let browseRoomsTimer = null;
function bindRoomJoin() {
  document.getElementById('roomJoinForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = document.getElementById('roomCodeInput').value.trim().toUpperCase();
    if (!code) return;
    joinRoomByCode(code);
  };
  const refreshBtn = document.getElementById('refreshRoomsBtn');
  if (refreshBtn) refreshBtn.onclick = async () => {
    refreshBtn.classList.add('spinning');
    refreshBtn.disabled = true;
    await loadBrowseRooms();
    refreshBtn.classList.remove('spinning');
    refreshBtn.disabled = false;
  };

  bindBrowseRoomsList();
  loadBrowseRooms();

  // keep the open-rooms list fresh while the screen is up (players joining/leaving elsewhere)
  clearInterval(browseRoomsTimer);
  browseRoomsTimer = setInterval(() => {
    if (state.view === 'roomJoin') loadBrowseRooms();
    else clearInterval(browseRoomsTimer);
  }, 5000);
}

function roomErrorMessage(err) {
  if (err.network) return 'Не удалось связаться с сервером.';
  if (err.code === 'room_not_found') return 'Комната с таким кодом не найдена.';
  if (err.code === 'room_already_started') return 'Игра в этой комнате уже началась.';
  if (err.code === 'room_full') return 'Комната заполнена.';
  if (err.code === 'wrong_password') return 'Неверный пароль комнаты.';
  return 'Не получилось войти в комнату.';
}

/* ============ ROOMS: WEBSOCKET CLIENT ============ */
let roomReconnectAttempt = 0;
let roomReconnectTimer = null;
let roomWasManuallyClosed = false;
// A dropped connection that reconnects within this window never shows the
// "соединение прервалось" banner at all — mobile networks flap constantly
// (screen lock, tower handoff, a few seconds off wifi) and the socket is
// usually back before a human would notice. Only a drop that outlives this
// grace period is treated as an actual, worth-mentioning disconnect.
const RECONNECT_BANNER_DELAY_MS = 2500;
let reconnectBannerTimer = null;

function connectRoomSocket(code, isReconnect) {
  if (!isReconnect) {
    roomWasManuallyClosed = false;
    roomReconnectAttempt = 0;
    clearTimeout(roomReconnectTimer);
    clearTimeout(reconnectBannerTimer);
    state.wsQuestion = null;
    state.wsDeadline = 0;
    stopRoomTimer();
    state.wsAnswered = false;
    state.wsAnsweredUsers = [];
    state.wsReveal = null;
    state.wsLeaderboard = null;
    state.roundStartShown = false;
  }
  disconnectRoomSocket({ manual: false }); // close any stale socket without cancelling a reconnect in progress

  const token = Api.getToken();
  const ws = new WebSocket(`${WS_BASE}/ws/room?token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`);
  state.ws = ws;
  // Note: state.wsReconnecting is intentionally NOT set here. It only flips to
  // true after RECONNECT_BANNER_DELAY_MS of actually being disconnected (see
  // onclose below), so a fast reconnect never renders the banner at all.

  ws.onopen = () => {
    roomReconnectAttempt = 0;
    clearTimeout(reconnectBannerTimer);
    if (state.wsReconnecting) {
      state.wsReconnecting = false;
      if (ROOM_VIEWS.has(state.view)) render();
    }
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    handleRoomMessage(msg);
  };

  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
    stopRoomTimer();
    Sound.stopMusic({ fade: false });

    // Only auto-reconnect if we're still meant to be in this room: not a
    // deliberate leave, and the room screen is still (or again) up front.
    if (roomWasManuallyClosed || !state.room || !ROOM_VIEWS.has(state.view)) return;

    roomReconnectAttempt++;
    // Start reconnecting immediately, but only surface the banner if we're
    // still down after the grace period — a normal lobby refresh or a quick
    // network blip resolves well before this fires.
    clearTimeout(reconnectBannerTimer);
    reconnectBannerTimer = setTimeout(() => {
      if (!state.room || state.ws) return; // already reconnected
      state.wsReconnecting = true;
      if (ROOM_VIEWS.has(state.view)) render();
    }, RECONNECT_BANNER_DELAY_MS);
    const delay = Math.min(1000 * 2 ** (roomReconnectAttempt - 1), 8000);
    clearTimeout(roomReconnectTimer);
    roomReconnectTimer = setTimeout(() => connectRoomSocket(code, true), delay);
  };

  ws.onerror = () => {};
}

function disconnectRoomSocket(opts) {
  const manual = !opts || opts.manual !== false;
  if (manual) {
    roomWasManuallyClosed = true;
    clearTimeout(roomReconnectTimer);
    clearTimeout(reconnectBannerTimer);
    state.wsReconnecting = false;
  }
  if (state.ws) {
    try { state.ws.close(); } catch (e) {}
    state.ws = null;
  }
}

function sendRoomMessage(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

function handleRoomMessage(msg) {
  switch (msg.type) {
    case 'lobby_update': {
      const prevIds = state.knownMemberIds;
      const newMembers = prevIds ? msg.members.filter((m) => !prevIds.has(m.id)) : [];
      const nextIds = new Set(msg.members.map((m) => m.id));

      // Skip the render entirely if nothing a human would notice actually
      // changed — same members, same room fields. Stops the lobby from
      // redrawing (and re-flashing its enter animation) on no-op broadcasts.
      const sameMembers = prevIds && prevIds.size === nextIds.size && [...nextIds].every((id) => prevIds.has(id));
      const sameRoomFields = !msg.room || !state.room || (
        msg.room.name === state.room.name &&
        (msg.room.hostUserId || state.room.hostUserId) === state.room.hostUserId &&
        (msg.room.maxPlayers || 0) === (state.room.maxPlayers || 0) &&
        (msg.room.questionSeconds || 20) === (state.room.questionSeconds || 20) &&
        !!msg.room.teamMode === !!state.room.teamMode
      );
      const sameStandings = JSON.stringify(msg.teamStandings || null) === JSON.stringify(state.teamStandings || null);
      const noOp = sameMembers && sameRoomFields && sameStandings;

      state.roomMembers = msg.members;
      state.teamStandings = msg.teamStandings || null;
      if (msg.room && state.room) {
        state.room.name = msg.room.name;
        if (msg.room.hostUserId) state.room.hostUserId = msg.room.hostUserId;
        state.room.maxPlayers = msg.room.maxPlayers || 0;
        state.room.questionSeconds = msg.room.questionSeconds || 20;
        state.room.teamMode = !!msg.room.teamMode;
      }
      if (!noOp && state.view === 'roomLobby') {
        // Patch just the member list in place rather than replacing the whole
        // lobby screen — the room-code banner, chat FAB and everything else
        // stay untouched, so they don't replay their entrance animation.
        const listEl = document.getElementById('roomMemberListWrap');
        if (listEl) {
          listEl.innerHTML = roomMemberListHTML();
          bindRoomMemberList();
        } else {
          document.getElementById('appMain').innerHTML = roomLobbyHTML();
          bindRoomLobby();
        }
      }
      if (state.view === 'roomLobby') syncLobbyMemberControls();
      renderChatFab();
      // Play the join chime after rendering (so the animation and sound land together),
      // but only for players other than us — our own join doesn't need a sound cue.
      if (prevIds) {
        const othersJoined = newMembers.filter((m) => !state.user || m.id !== state.user.id);
        if (othersJoined.length && state.view === 'roomLobby') {
          Sound.click();
          if (othersJoined.length === 1) {
            showToast(othersJoined[0].displayName + ' зашёл в лобби', ICONS.users);
          } else {
            showToast(othersJoined.length + ' новых игрока в лобби', ICONS.users);
          }
        } else if (othersJoined.length) {
          Sound.click();
        }
      }
      state.knownMemberIds = nextIds;
      break;
    }

    case 'chat_history':
      state.chatMessages = msg.messages || [];
      if (state.view === 'roomLobby' || state.view === 'roomPlay') renderChatFab();
      break;

    case 'chat_message': {
      // Belt-and-suspenders dedup: if this message id is already in the list
      // (e.g. a redelivery during a reconnect race), don't add it twice.
      if (msg.id != null && state.chatMessages.some((m) => m.id === msg.id)) break;
      state.chatMessages.push(msg);
      const mine = state.user && msg.fromUserId === state.user.id;
      const chatOverlay = document.getElementById('chatOverlay');
      const chatOpen = chatOverlay && chatOverlay.classList.contains('open');

      // An incoming DM jumps straight to that thread and opens the chat, so a
      // private message is never silently missed behind whatever tab happens
      // to be selected (lobby, team, or a different DM).
      if (msg.scope === 'dm' && !mine) {
        const otherUserId = msg.fromUserId;
        const switchingThread = state.chatScope !== 'dm' || state.chatDmUserId !== otherUserId;
        if (switchingThread) {
          state.chatScope = 'dm';
          state.chatDmUserId = otherUserId;
          openChat('dm', otherUserId);
        } else if (chatOpen) {
          renderChatMessages();
        }
        if (!chatOpen) {
          state.chatUnread += 1;
          Sound.notify();
        }
        renderChatFab();
        break;
      }

      const relevantToOpenTab = chatOpen && (
        (msg.scope === 'lobby' && state.chatScope === 'lobby') ||
        (msg.scope === 'team' && state.chatScope === 'team') ||
        (msg.scope === 'dm' && state.chatScope === 'dm' && (msg.fromUserId === state.chatDmUserId || msg.toUserId === state.chatDmUserId))
      );
      if (relevantToOpenTab) {
        renderChatMessages();
      } else if (!mine) {
        state.chatUnread += 1;
        Sound.notify();
      }
      renderChatFab();
      break;
    }

    case 'player_stats':
      state.viewedPlayerStats = msg.stats;
      if (!state.viewedPlayerMember && msg.stats) {
        state.viewedPlayerMember = {
          id: msg.stats.userId, displayName: msg.stats.displayName, avatarUrl: msg.stats.avatarUrl,
          avatarEmoji: msg.stats.avatarEmoji, avatarColor: msg.stats.avatarColor, team: msg.stats.team,
        };
      }
      renderPlayerProfileBody();
      break;

    case 'status':
      if (state.room) state.room.status = msg.status;
      if (msg.status === 'generating' && state.view === 'roomLobby') {
        state.roomGenStatusText = 'Готовлю вопросы...';
        state.roomGenPercent = 0;
        document.getElementById('appMain').innerHTML = roomLobbyHTML();
        bindRoomLobby();
      }
      if (msg.status === 'lobby' && (state.view === 'roomPlay' || state.view === 'roomResult')) {
        state.wsQuestion = null;
        state.wsReveal = null;
        state.wsLeaderboard = null;
        state.roundStartShown = false;
        Sound.stopMusic();
        state.view = 'roomLobby';
        render();
      }
      if (msg.status === 'lobby' && state.view === 'roomLobby') {
        document.getElementById('appMain').innerHTML = roomLobbyHTML();
        bindRoomLobby();
      }
      break;

    case 'gen_progress': {
      // Live, non-narrated status of what the model is actually doing right now
      // (searching, reading a result, fact-checking) — no source links, text only.
      const label = roomGenProgressLabel(msg);
      if (label) {
        state.roomGenStatusText = label;
        const el = document.getElementById('roomGenStatus');
        if (el) el.innerHTML = label;
      }
      const pct = roomGenProgressPercent(msg);
      if (pct !== null) {
        state.roomGenPercent = pct;
        const fill = document.getElementById('roomGenFill');
        const pctEl = document.getElementById('roomGenPercentText');
        if (fill) fill.style.width = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';
      }
      break;
    }

    case 'question':
      state.wsQuestion = msg;
      state.wsDeadline = msg.deadline || (Date.now() + 20000);
      state.wsAnswered = false;
      state.wsAnsweredUsers = [];
      state.wsReveal = null;
      if (msg.index === 0 && !state.roundStartShown) {
        // First question of a fresh game: run the countdown, then reveal the round.
        state.roundStartShown = true;
        state.wsQuestion = null; // hold the question off-screen until the countdown finishes
        state.view = 'roomPlay';
        render();
        playRoundStartSequence(() => {
          state.wsQuestion = msg;
          document.getElementById('appMain').innerHTML = roomPlayHTML();
          bindRoomPlay();
          Sound.startMusic();
        });
        break;
      }
      if (state.view !== 'roomPlay') { state.view = 'roomPlay'; render(); }
      else { document.getElementById('appMain').innerHTML = roomPlayHTML(); bindRoomPlay(); }
      break;

    case 'player_answered':
      if (!state.wsAnsweredUsers.includes(msg.userId)) state.wsAnsweredUsers.push(msg.userId);
      if (state.user && msg.userId !== state.user.id) Sound.notify();
      if (state.view === 'roomPlay') updateAnsweredPills();
      break;

    case 'reveal':
      state.wsReveal = msg;
      state.teamStandings = msg.teamStandings || state.teamStandings;
      if (state.user) {
        const mineAnswer = msg.answers.find((a) => a.userId === state.user.id);
        if (mineAnswer) { mineAnswer.isCorrect ? Sound.correct() : Sound.wrong(); }
      }
      if (state.view === 'roomPlay') { document.getElementById('appMain').innerHTML = roomPlayHTML(); bindRoomPlay(); }
      break;

    case 'game_over':
      state.prevLeaderboardOrder = (state.wsLeaderboard || []).map((m) => m.id);
      state.wsLeaderboard = msg.leaderboard;
      state.teamStandings = msg.teamStandings || null;
      state.wsPlayerStatsById = new Map((msg.playerStats || []).map((s) => [s.userId, s]));
      state.roundStartShown = false;
      Sound.stopMusic();
      state.view = 'roomResult';
      render();
      playLeaderboardRevealSequence();
      break;

    case 'error':
      showToast(msg.message === 'room_not_found' ? 'Комната не найдена' : (msg.message || 'Ошибка комнаты'), ICONS.cross);
      break;
  }
}

/* ============ ROOMS: LOBBY ============ */
const TEAM_KEYS = ['A', 'B', 'C', 'D'];
const TEAM_LABELS = { A: 'Команда А', B: 'Команда Б', C: 'Команда В', D: 'Команда Г' };
const TEAM_COLORS = { A: '#3D3AF1', B: '#E8536F', C: '#22B37A', D: '#E8A33D' };

function memberRowHTML(m, i, room, isHost) {
  const isMe = state.user && m.id === state.user.id;
  const isNew = state.knownMemberIds && !state.knownMemberIds.has(m.id);
  return `
    <div class="member-row ${isNew ? 'member-row--joining' : ''}" style="--stagger:${i};">
      <button class="profile-open-btn" data-player-id="${m.id}">
        ${avatarHTML(m, 'md')}
        <span class="name">${escapeHtml(m.displayName)}${isMe ? ' (вы)' : ''}</span>
      </button>
      ${m.id === room.hostUserId ? `<span class="role-tag">Хост</span>` : ''}
      ${room.teamMode ? (
        isHost
          ? `<select class="team-select" data-assign-team="${m.id}">
               <option value="" ${!m.team ? 'selected' : ''}>Без команды</option>
               ${TEAM_KEYS.map((k) => `<option value="${k}" ${m.team === k ? 'selected' : ''}>${TEAM_LABELS[k]}</option>`).join('')}
             </select>`
          : (m.team ? `<span class="team-pill" style="background:${TEAM_COLORS[m.team]};">${TEAM_LABELS[m.team]}</span>` : `<span class="team-pill" style="background:var(--ink-faint);">Без команды</span>`)
      ) : ''}
    </div>
  `;
}

/* Turns a real gen_progress WS event (relayed from the server's live tool-use
   loop) into a short human status line — no source links or URLs, just what
   the model is actually doing right now: writing questions, searching the web,
   reading a page, or fact-checking a batch before it reaches players. */
function roomGenProgressLabel(evt) {
  switch (evt.type) {
    case 'batch_start':
      return evt.have > 0
        ? `ИИ уже подготовил ${evt.have}/${evt.total}; генерирую дальше...`
        : (evt.attempt > 1 ? `Продолжаю генерацию вопросов (попытка ${evt.attempt})...` : 'ИИ генерирует вопросы...');
    case 'rate_limit_wait':
      return `Запросов много — подожду ${evt.seconds} сек. и продолжу. Готовые вопросы сохранены.`;
    case 'web_search': {
      const q = (evt.query || '').length > 40 ? evt.query.slice(0, 40) + '…' : (evt.query || '');
      // Numbers/dates arrive already masked as ▓ blocks (server-side, before this
      // ever reaches the client) — wrap just those blocks in a blur span so a
      // masked figure reads visually as "hidden", not as a typo or garbage text.
      const blurred = escapeHtml(q).replace(/▓+/g, (m) => `<span class="gen-spoiler-blur">${m}</span>`);
      return `Ищу в интернете: «${blurred}»...`;
    }
    case 'web_search_done':
      return evt.ok ? `Нашёл ${evt.count} результат(ов), читаю их...` : 'Поиск не удался, пробую иначе...';
    case 'web_fetch':
      return 'Открываю страницу для проверки...';
    case 'web_fetch_done':
      return 'Страница прочитана, разбираю данные...';
    case 'fact_check_start':
      return `Проверяю факты (${evt.count} вопрос${evt.count === 1 ? '' : 'ов'})...`;
    case 'fact_check_done':
      return `Проверка завершена: ${evt.kept}/${evt.total} прошли фактчек`;
    case 'batch_done':
      return `Готово вопросов: ${evt.have}/${evt.total}`;
    default:
      return null;
  }
}

// Real completion percent for the lobby's generation bar — driven only by
// actual accepted question counts from the server (batch_start and
// batch_done both carry have/total), never a timer or a guess.
function roomGenProgressPercent(evt) {
  if ((evt.type === 'batch_done' || evt.type === 'batch_start') && evt.total > 0) {
    return Math.min(100, Math.round((evt.have / evt.total) * 100));
  }
  return null;
}

// Member roster markup, isolated so lobby_update can patch just this element
// instead of redrawing the whole lobby (banner, chat, etc.) on every join/leave —
// that full-screen replace was what made the lobby's fade-in replay constantly.
function roomMemberListHTML() {
  const room = state.room;
  if (!room) return '';
  const isHost = state.user && room.hostUserId === state.user.id;
  const members = state.roomMembers || [];
  const teamMode = !!room.teamMode;
  const grouped = teamMode ? (() => {
    const byTeam = new Map(TEAM_KEYS.map((k) => [k, []]));
    const unassigned = [];
    for (const m of members) {
      if (m.team && byTeam.has(m.team)) byTeam.get(m.team).push(m);
      else unassigned.push(m);
    }
    return { byTeam, unassigned };
  })() : null;

  if (teamMode) {
    return `
      <div class="member-list">
        ${TEAM_KEYS.filter((k) => grouped.byTeam.get(k).length).map((k) => `
          <div class="team-group">
            <div class="team-group-head">
              <span class="team-group-dot" style="background:${TEAM_COLORS[k]};"></span>
              <span class="team-group-name">${TEAM_LABELS[k]}</span>
            </div>
            ${grouped.byTeam.get(k).map((m, i) => memberRowHTML(m, i, room, isHost)).join('')}
          </div>
        `).join('')}
        ${grouped.unassigned.length ? `
          <div class="team-group">
            <div class="team-group-head"><span class="team-group-name" style="color:var(--ink-faint);">Без команды</span></div>
            ${grouped.unassigned.map((m, i) => memberRowHTML(m, i, room, isHost)).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }
  return `
    <div class="member-list">
      ${members.map((m, i) => memberRowHTML(m, i, room, isHost)).join('')}
    </div>
  `;
}

function bindRoomMemberList() {
  document.querySelectorAll('[data-assign-team]').forEach((sel) => {
    sel.onchange = () => {
      sendRoomMessage({ type: 'assign_team', userId: parseInt(sel.dataset.assignTeam, 10), team: sel.value || null });
    };
  });
  document.querySelectorAll('[data-player-id]').forEach((btn) => {
    btn.onclick = () => openPlayerProfile(parseInt(btn.dataset.playerId, 10));
  });
}

function roomCapacityHTML() {
  const members = state.roomMembers || [];
  const maxPlayers = state.room?.maxPlayers;
  return `<div class="room-capacity-avatars">
    ${members.slice(0, 5).map((m) => avatarHTML(m, 'sm')).join('')}
    ${members.length > 5 ? `<span class="avatar sm room-browse-more">+${members.length - 5}</span>` : ''}
  </div>
  <span class="room-capacity-count">
    ${ICONS.users} ${members.length} <span class="room-capacity-max">${maxPlayers ? '/ ' + maxPlayers : 'без лимита'}</span>
  </span>`;
}

function syncLobbyMemberControls() {
  const members = state.roomMembers || [];
  const capacityEl = document.getElementById('roomCapacityPill');
  if (capacityEl) capacityEl.innerHTML = roomCapacityHTML();
  const membersLabel = document.getElementById('roomMembersLabel');
  if (membersLabel) membersLabel.textContent = `Игроки (${members.length}${state.room?.maxPlayers ? ' / ' + state.room.maxPlayers : ''})`;
  const startBtn = document.getElementById('startRoomGameBtn');
  if (startBtn) startBtn.disabled = members.length === 0 || state.room?.status !== 'lobby';
}

function roomLobbyHTML() {
  const room = state.room;
  if (!room) return `<div class="empty-state">${ICONS.users}<div class="title">Комната не найдена</div></div>`;

  const isHost = state.user && room.hostUserId === state.user.id;
  const generating = room.status === 'generating';
  const members = state.roomMembers || [];
  const teamMode = !!room.teamMode;
  const standings = state.teamStandings || [];

  return `
    ${state.wsReconnecting ? `
      <div class="panel reconnect-banner view">
        ${LOADER('inline')} Соединение прервалось — переподключаюсь...
      </div>
    ` : ''}
    <div class="panel room-code-banner view">
      <div>
        <div class="lbl">${escapeHtml(room.name || 'Лобби')} · код для друзей</div>
        <div class="code tabular">${escapeHtml(room.code)}</div>
      </div>
      <button class="btn-ghost" id="copyCodeBtn">${ICONS.copy} Скопировать</button>
    </div>

    <div class="room-capacity-pill" id="roomCapacityPill">${roomCapacityHTML()}</div>

    <div class="section-label">Общее</div>
    <div class="panel lobby-general-panel">
      <div class="lobby-general-item full">
        <div class="label">Название</div>
        <div class="value" style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
          <span>${escapeHtml(room.name || '—')}</span>
          ${isHost ? '<button class="btn-ghost" id="renameRoomBtn" style="width:auto; padding:4px 10px; font-size:12px; flex-shrink:0;">Изменить</button>' : ''}
        </div>
      </div>
      <div class="lobby-general-item"><div class="label">Тема</div><div class="value">${escapeHtml(room.topic || 'Без темы')}</div></div>
      <div class="lobby-general-item"><div class="label">Режим</div><div class="value">${room.mode === 'blitz' ? 'Блиц' : 'Классика'}</div></div>
      <div class="lobby-general-item"><div class="label">Вопросы</div><div class="value">${room.questionCount || '—'}</div></div>
    </div>

    <div class="section-label">${ICONS.users} Командный режим</div>
    <div class="panel team-toggle-row">
      <span style="font-weight:600; font-size:13.5px;">${teamMode ? 'Включён — игроки разбиты на команды' : 'Выключен — считаем очки лично'}</span>
      ${isHost
        ? `<button class="switch ${teamMode ? 'on' : ''}" id="teamModeToggle" role="switch" aria-checked="${teamMode}"><span class="switch-knob"></span></button>`
        : `<span class="chip" style="cursor:default;">${teamMode ? 'Вкл' : 'Выкл'}</span>`
      }
    </div>

    ${teamMode && standings.length ? `
      <div class="team-standings-wrap">
        ${standings.map((t) => `
          <div class="team-standing-row" style="border-left:4px solid ${t.color};">
            <span class="team-dot" style="background:${t.color};"></span>
            <span class="team-name">${escapeHtml(t.name)}<div class="team-standing-members">${t.members.length} игрок${t.members.length === 1 ? '' : t.members.length < 5 ? 'а' : 'ов'}</div></span>
            <span class="team-score tabular">${t.score}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <div class="section-label" id="roomMembersLabel">Игроки (${members.length}${room.maxPlayers ? ' / ' + room.maxPlayers : ''})</div>
    <div id="roomMemberListWrap">${roomMemberListHTML()}</div>

    <div style="margin-top:22px;">
      ${isHost
        ? `<button class="btn-primary" id="startRoomGameBtn" ${generating || members.length < 1 ? 'disabled' : ''}>
             ${generating ? LOADER('inline') + ' Готовим вопросы...' : ICONS.arrowRight + ' Начать игру'}
           </button>`
        : `<div class="empty-state" style="padding:16px;"><div class="sub">${generating ? 'Хост запускает игру, вопросы готовятся...' : 'Ждём, пока хост начнёт игру.'}</div></div>`
      }
      ${generating ? `
        <div class="gen-live-status" id="roomGenStatus">${state.roomGenStatusText ? state.roomGenStatusText : 'Готовлю вопросы...'}</div>
        <div class="progress-track" style="margin-top:8px;">
          <div class="progress-fill" id="roomGenFill" style="width:${state.roomGenPercent || 0}%;"></div>
        </div>
        <div class="lbl" id="roomGenPercentText" style="text-align:right; margin-top:4px;">${state.roomGenPercent || 0}%</div>
      ` : ''}
    </div>
    <button class="btn-ghost room-leave-btn" id="leaveLobbyBtn">${ICONS.cross} Выйти из лобби</button>
  `;
}

function bindRoomLobby() {
  const renameBtn = document.getElementById('renameRoomBtn');
  if (renameBtn) renameBtn.onclick = () => {
    const next = prompt('Новое название лобби:', state.room.name || '');
    if (next && next.trim()) sendRoomMessage({ type: 'rename_room', name: next.trim() });
  };
  const copyBtn = document.getElementById('copyCodeBtn');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(state.room.code);
        showToast('Код скопирован');
      } catch (e) {
        showToast('Код: ' + state.room.code);
      }
    };
  }
  const startBtn = document.getElementById('startRoomGameBtn');
  if (startBtn) {
    startBtn.onclick = () => { Sound.click(); sendRoomMessage({ type: 'start_game' }); };
  }
  bindRoomMemberList();
  renderChatFab();

  const leaveBtn = document.getElementById('leaveLobbyBtn');
  if (leaveBtn) leaveBtn.onclick = () => goHome();

  const teamToggle = document.getElementById('teamModeToggle');
  if (teamToggle) teamToggle.onclick = () => {
    Sound.click();
    sendRoomMessage({ type: 'set_team_mode', teamMode: !state.room.teamMode });
  };
}

/* ============ ROUND START COUNTDOWN ============ */
function playRoundStartSequence(onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'round-start-overlay';
  overlay.innerHTML = `<div class="round-start-num" id="roundStartNum">3</div>`;
  document.body.appendChild(overlay);

  const numEl = overlay.querySelector('#roundStartNum');
  const steps = ['3', '2', '1', 'СТАРТ'];
  let i = 0;

  function showStep() {
    const label = steps[i];
    numEl.textContent = label;
    numEl.classList.remove('pulse');
    // restart the CSS animation
    void numEl.offsetWidth;
    numEl.classList.add('pulse');

    if (label === 'СТАРТ') {
      numEl.classList.add('go');
      Sound.go();
    } else {
      Sound.tick(label === '1');
    }
  }

  showStep();
  const interval = setInterval(() => {
    i++;
    if (i >= steps.length) {
      clearInterval(interval);
      setTimeout(() => {
        overlay.classList.add('fade-out');
        setTimeout(() => {
          overlay.remove();
          onDone();
        }, 260);
      }, 550);
      return;
    }
    showStep();
  }, 1000);
}

/* ============ ROOMS: PLAY ============ */
function roomPlayHTML() {
  const q = state.wsQuestion;
  if (!q) {
    return `<div class="panel gen-wrap view">${todGeneratingHTML(0, 4, 'Готовим вопросы...')}</div>`;
  }

  const progressPct = Math.round((q.index / q.total) * 100);
  const reveal = state.wsReveal && state.wsReveal.index === q.index ? state.wsReveal : null;
  const myMember = state.roomMembers.find((m) => state.user && m.id === state.user.id) || {};
  const myScore = myMember.score || 0;
  const myTeamStanding = (state.room.teamMode && myMember.team) ? (state.teamStandings || []).find((t) => t.team === myMember.team) : null;

  return `
    <div class="quiz-topline">
      <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>
      <span class="quiz-counter">${q.index + 1} / ${q.total}</span>
      <span class="timer-badge" id="roomTimerBadge">${ICONS.clock} 20с</span>
      <span class="score-badge">${ICONS.trophy} ${myScore}</span>
      ${myTeamStanding ? `<span class="score-badge" style="background:${TEAM_COLORS[myMember.team]}22; color:${TEAM_COLORS[myMember.team]};">${ICONS.users} ${myTeamStanding.score}</span>` : ''}
    </div>
    <div class="panel question-card view">
      <div class="question-category">${ICONS.tag} ${escapeHtml(state.room.topic || 'Викторина')}</div>
      <div class="question-text">${escapeHtml(q.question.question)}</div>
    </div>
    <div class="answers-grid">
      ${q.question.options.map((opt, i) => {
        let cls = 'answer-btn';
        if (reveal) {
          if (i === reveal.correct) cls += ' correct';
          else if (state.myLastAnswerIdx === i) cls += ' wrong';
        }
        const votersHTML = reveal ? answerVotersHTML(reveal, i) : '';
        return `
        <button class="answer-btn ${reveal ? (i === reveal.correct ? 'correct' : (state.myLastAnswerIdx === i ? 'wrong' : '')) : ''}"
          data-idx="${i}" ${state.wsAnswered || reveal ? 'disabled' : ''}>
          <span style="display:flex; align-items:center; gap:11px;">
            <span class="answer-letter">${String.fromCharCode(65 + i)}</span>
            <span>${escapeHtml(opt)}</span>
          </span>
          <span class="answer-check">${ICONS.check}</span>
        </button>${votersHTML}`;
      }).join('')}
    </div>
    <div class="answered-others" id="answeredOthers">${answeredPillsHTML()}</div>
    ${reveal ? revealBannerHTML(reveal) : ''}
    <button class="btn-ghost room-leave-btn" id="leavePlayBtn">${ICONS.cross} Выйти из комнаты</button>
  `;
}

function answeredPillsHTML() {
  const members = state.roomMembers || [];
  const answeredIds = new Set(state.wsAnsweredUsers || []);
  return members
    .filter((m) => answeredIds.has(m.id))
    .map((m) => `<span class="answered-pill" data-player-id="${m.id}" style="cursor:pointer;">${ICONS.check} ${escapeHtml(m.displayName)}</span>`)
    .join('');
}

function bindPlayerProfileTriggers(root) {
  (root || document).querySelectorAll('[data-player-id]').forEach((el) => {
    el.onclick = () => openPlayerProfile(parseInt(el.dataset.playerId, 10));
  });
}

function updateAnsweredPills() {
  const el = document.getElementById('answeredOthers');
  if (el) { el.innerHTML = answeredPillsHTML(); bindPlayerProfileTriggers(el); }
}

function answerVotersHTML(reveal, optionIdx) {
  const voters = reveal.answers.filter((a) => a.optionIdx === optionIdx);
  if (!voters.length) return '';
  return `
    <div class="answer-voters">
      ${voters.map((a) => `
        <span class="voter-pill ${a.isCorrect ? 'voter-correct' : 'voter-wrong'}" data-player-id="${a.userId}" style="cursor:pointer;">
          ${a.isCorrect ? ICONS.check : ICONS.cross} ${escapeHtml(a.displayName)}
        </span>`).join('')}
    </div>
  `;
}

function revealBannerHTML(reveal) {
  const correctCount = reveal.answers.filter((a) => a.isCorrect).length;
  const correctNames = reveal.answers.filter((a) => a.isCorrect).map((a) => a.displayName);
  const wrongNames = reveal.answers.filter((a) => !a.isCorrect).map((a) => a.displayName);
  return `
    <div class="field" style="margin-top:14px; text-align:center;">
      <div class="field-hint" style="font-size:13px;">Верно ответили: ${correctCount} из ${reveal.answers.length}. Следующий вопрос через пару секунд...</div>
      <div class="reveal-summary">
        ${correctNames.length ? `
          <div class="reveal-summary-row">
            <span class="reveal-summary-label good">${ICONS.check} Правильно:</span>
            <span class="reveal-summary-names">${correctNames.map(escapeHtml).join(', ')}</span>
          </div>` : ''}
        ${wrongNames.length ? `
          <div class="reveal-summary-row">
            <span class="reveal-summary-label bad">${ICONS.cross} Неправильно:</span>
            <span class="reveal-summary-names">${wrongNames.map(escapeHtml).join(', ')}</span>
          </div>` : ''}
      </div>
    </div>
  `;
}

function bindRoomPlay() {
  stopRoomTimer();
  if (!state.wsReveal && state.wsDeadline) {
    state.roomTimerInterval = setInterval(() => {
      const badge = document.getElementById('roomTimerBadge');
      const seconds = Math.max(0, Math.ceil((state.wsDeadline - Date.now()) / 1000));
      if (badge) {
        badge.innerHTML = ICONS.clock + ' ' + seconds + 'с';
        badge.classList.toggle('warn', seconds <= 5);
      }
      if (seconds <= 0) stopRoomTimer();
    }, 250);
  }
  document.querySelectorAll('.answer-btn').forEach((btn) => {
    btn.onclick = () => {
      if (state.wsAnswered || state.wsReveal) return;
      const idx = parseInt(btn.dataset.idx, 10);
      state.myLastAnswerIdx = idx;
      state.wsAnswered = true;
      Sound.click();
      document.querySelectorAll('.answer-btn').forEach((b) => (b.disabled = true));
      btn.classList.add('picked');
      sendRoomMessage({ type: 'submit_answer', questionIdx: state.wsQuestion.index, optionIdx: idx });
    };
  });
  const leaveBtn = document.getElementById('leavePlayBtn');
  if (leaveBtn) leaveBtn.onclick = () => goHome();

  bindPlayerProfileTriggers(document.getElementById('appMain'));
  renderChatFab();
}

/* ============ ROOMS: RESULT (Kahoot-style podium + animated leaderboard) ============ */
function podiumSlotHTML(m, place) {
  if (!m) return `<div class="podium-slot p${place}"></div>`;
  const crown = place === 1 ? '👑' : place === 2 ? '🥈' : '🥉';
  return `
    <div class="podium-slot p${place}" data-player-id="${m.id}">
      <div class="podium-avatar-wrap">
        <span class="podium-crown">${crown}</span>
        ${avatarHTML(m, 'md')}
      </div>
      <div class="podium-name">${escapeHtml(m.displayName)}</div>
      <div class="podium-score tabular">${m.score}</div>
      <div class="podium-bar">${place}</div>
    </div>
  `;
}

function roomResultHTML() {
  const board = state.wsLeaderboard || [];
  const top3 = [board[0], board[1], board[2]];
  const rest = board.slice(3);
  const prevOrder = state.prevLeaderboardOrder || [];
  const teamMode = !!(state.room && state.room.teamMode);
  const standings = state.teamStandings || [];

  return `
    <div class="panel result-hero view">
      <div class="result-trophy">${ICONS.trophy}</div>
      <div class="result-title">Игра окончена</div>
      <div class="result-sub">${teamMode ? 'Командный зачёт и личная таблица' : 'Итоговая таблица результатов'}</div>

      ${teamMode && standings.length ? `
        <div class="team-standings-wrap" style="text-align:left; max-width:360px; margin:0 auto 22px;">
          ${standings.map((t, i) => `
            <div class="team-standing-row ${i === 0 ? 'leading' : ''}" style="border-left:4px solid ${t.color};">
              <span class="team-dot" style="background:${t.color};"></span>
              <span class="team-name">${i === 0 ? '🏆 ' : ''}${escapeHtml(t.name)}</span>
              <span class="team-score tabular">${t.score}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${board.length ? `
        <div class="podium-wrap">
          ${podiumSlotHTML(top3[1], 2)}
          ${podiumSlotHTML(top3[0], 1)}
          ${podiumSlotHTML(top3[2], 3)}
        </div>
      ` : ''}

      ${rest.length ? `
        <div style="text-align:left; max-width:360px; margin:0 auto 22px;">
          ${rest.map((m, i) => {
            const prevIdx = prevOrder.indexOf(m.id);
            const curIdx = i + 3;
            let delta = '';
            if (prevIdx !== -1 && prevIdx !== curIdx) {
              delta = prevIdx > curIdx
                ? `<span class="lb-delta up">▲ ${prevIdx - curIdx}</span>`
                : `<span class="lb-delta down">▼ ${curIdx - prevIdx}</span>`;
            }
            return `
              <div class="leaderboard-row rest-row" style="--stagger:${i};" data-player-id="${m.id}">
                <span style="display:flex; align-items:center; gap:10px;">
                  <span class="leaderboard-rank">${curIdx + 1}</span>
                  ${avatarHTML(m, 'md')}
                  <span style="font-weight:600;">${escapeHtml(m.displayName)}${teamMode && m.team ? ` <span class="team-pill" style="background:${TEAM_COLORS[m.team]};">${TEAM_LABELS[m.team]}</span>` : ''}</span>
                </span>
                <span style="display:flex; align-items:center;">
                  <span class="tabular" style="font-weight:700;">${m.score}</span>
                  ${delta}
                </span>
              </div>
            `;
          }).join('')}
        </div>
      ` : ''}

      <div class="result-actions">
        ${state.user && state.room && state.room.hostUserId === state.user.id
          ? `<button class="btn-ghost" id="playAgainBtn">${ICONS.refresh} Сыграть ещё раз</button>`
          : `<span class="field-hint">Ждём, пока хост начнёт новую игру...</span>`
        }
        <button class="btn-ghost" id="leaveRoomBtn">${ICONS.home} На главную</button>
      </div>
    </div>
  `;
}

function bindRoomResult() {
  const again = document.getElementById('playAgainBtn');
  if (again) again.onclick = () => sendRoomMessage({ type: 'play_again' });
  document.getElementById('leaveRoomBtn').onclick = () => goHome();
  document.querySelectorAll('[data-player-id]').forEach((el) => {
    el.onclick = () => openPlayerProfile(parseInt(el.dataset.playerId, 10));
  });
}

// Small fanfare on reveal: pop each podium slot in with a click, biggest sound on gold.
function playLeaderboardRevealSequence() {
  setTimeout(() => Sound.click(), 60);
  setTimeout(() => Sound.click(), 260);
  setTimeout(() => Sound.correct(), 560);
}

/* ============ ROOM CHAT ============ */
// A floating action button is injected next to the room screens (lobby + play) rather
// than living in the normal appMain re-render flow, so it survives the innerHTML swaps
// that happen on every lobby_update / question / reveal without flicker.
function renderChatFab() {
  if (!ROOM_VIEWS.has(state.view) || !state.room) {
    const existing = document.getElementById('roomChatFab');
    if (existing) existing.remove();
    return;
  }
  let fab = document.getElementById('roomChatFab');
  if (!fab) {
    fab = document.createElement('button');
    fab.id = 'roomChatFab';
    fab.className = 'chat-fab';
    fab.title = 'Чат';
    fab.onclick = openChat;
    document.body.appendChild(fab);
  }
  fab.innerHTML = ICONS.chat + (state.chatUnread > 0 ? `<span class="chat-fab-badge">${state.chatUnread > 9 ? '9+' : state.chatUnread}</span>` : '');
}

function chatTabsHTML() {
  const myTeam = (state.roomMembers.find((m) => state.user && m.id === state.user.id) || {}).team;
  const tabs = [{ key: 'lobby', label: 'Лобби' }];
  if (state.room && state.room.teamMode && myTeam) tabs.push({ key: 'team', label: 'Команда' });
  if (state.chatScope === 'dm' && state.chatDmUserId) {
    const dmUser = state.roomMembers.find((m) => m.id === state.chatDmUserId);
    tabs.push({ key: 'dm', label: dmUser ? escapeHtml(dmUser.displayName) : 'Личка' });
  }
  return tabs.map((t) => `<div class="chip ${state.chatScope === t.key ? 'active' : ''}" data-chat-tab="${t.key}">${t.label}</div>`).join('');
}

function openChat(scope, dmUserId) {
  state.chatScope = scope || state.chatScope || 'lobby';
  state.chatDmUserId = dmUserId || state.chatDmUserId || null;
  state.chatUnread = 0;
  renderChatFab();
  document.getElementById('chatTabs').innerHTML = chatTabsHTML();
  document.getElementById('chatTitle').textContent =
    state.chatScope === 'team' ? 'Командный чат' :
    state.chatScope === 'dm' ? 'Личные сообщения' : 'Чат лобби';
  document.getElementById('chatSendBtn').innerHTML = ICONS.send;
  bindChatTabs();
  renderChatMessages();
  document.getElementById('chatOverlay').classList.add('open');
  setTimeout(() => document.getElementById('chatInput').focus(), 150);
}

function bindChatTabs() {
  document.querySelectorAll('[data-chat-tab]').forEach((tab) => {
    tab.onclick = () => {
      state.chatScope = tab.dataset.chatTab;
      document.querySelectorAll('[data-chat-tab]').forEach((t) => t.classList.toggle('active', t === tab));
      document.getElementById('chatTitle').textContent =
        state.chatScope === 'team' ? 'Командный чат' :
        state.chatScope === 'dm' ? 'Личные сообщения' : 'Чат лобби';
      renderChatMessages();
    };
  });
}

function closeChat() {
  document.getElementById('chatOverlay').classList.remove('open');
}

function chatMessageVisible(m) {
  if (state.chatScope === 'lobby') return m.scope === 'lobby';
  if (state.chatScope === 'team') return m.scope === 'team';
  if (state.chatScope === 'dm') return m.scope === 'dm' && (m.fromUserId === state.chatDmUserId || m.toUserId === state.chatDmUserId);
  return false;
}

function renderChatMessages() {
  const wrap = document.getElementById('chatMessages');
  if (!wrap) return;
  const visible = (state.chatMessages || []).filter(chatMessageVisible);
  if (!visible.length) {
    wrap.innerHTML = `<div class="chat-empty">Пока тихо. Напишите первым!</div>`;
    return;
  }
  wrap.innerHTML = visible.map((m) => {
    const mine = state.user && m.fromUserId === state.user.id;
    return `
      <div class="chat-msg ${mine ? 'mine' : ''}">
        ${avatarHTML({ avatarUrl: m.avatarUrl, avatarEmoji: m.avatarEmoji, avatarColor: m.avatarColor }, '')}
        <div class="chat-bubble">
          ${!mine ? `<div class="chat-author">${escapeHtml(m.displayName || '')}</div>` : ''}
          <div class="chat-body">${escapeHtml(m.body)}</div>
        </div>
      </div>
    `;
  }).join('');
  wrap.scrollTop = wrap.scrollHeight;
}

function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const body = input.value.trim();
  if (!body) return;
  const payload = { type: 'send_message', scope: state.chatScope, body };
  if (state.chatScope === 'dm') payload.toUserId = state.chatDmUserId;
  sendRoomMessage(payload);
  input.value = '';
}

/* ============ PLAYER PROFILE MODAL ============ */
function openPlayerProfile(userId) {
  if (!Number.isInteger(userId)) return;
  const pools = [state.wsLeaderboard, state.roomMembers];
  let member = null;
  for (const pool of pools) {
    if (pool) { member = pool.find((m) => m.id === userId); if (member) break; }
  }
  state.viewedPlayerId = userId;
  state.viewedPlayerMember = member || null;
  state.viewedPlayerStats = null;
  renderPlayerProfileBody();
  document.getElementById('profileOverlay').classList.add('open');
  sendRoomMessage({ type: 'get_player_stats', userId });
}

function closePlayerProfile() {
  document.getElementById('profileOverlay').classList.remove('open');
}

function renderPlayerProfileBody() {
  const body = document.getElementById('profileBody');
  if (!body) return;
  const member = state.viewedPlayerMember;
  const stats = state.viewedPlayerStats;
  if (!member) { body.innerHTML = `<div class="chat-empty">Игрок не найден</div>`; return; }

  const isMe = state.user && member.id === state.user.id;
  const team = member.team;

  body.innerHTML = `
    <div class="profile-head">
      ${avatarHTML(member, 'md')}
      <div>
        <div class="profile-head-name">${escapeHtml(member.displayName)}${isMe ? ' (вы)' : ''}</div>
        ${team ? `<span class="profile-head-team" style="background:${TEAM_COLORS[team]};">${TEAM_LABELS[team]}</span>` : ''}
      </div>
    </div>
    ${stats ? `
      <div class="profile-stats-grid">
        <div class="profile-stat"><div class="num tabular">${stats.score}</div><div class="lbl">Очки</div></div>
        <div class="profile-stat"><div class="num tabular">${stats.accuracy}%</div><div class="lbl">Точность</div></div>
        <div class="profile-stat"><div class="num tabular">${stats.correct}/${stats.totalAnswered}</div><div class="lbl">Верных ответов</div></div>
        <div class="profile-stat"><div class="num tabular">${stats.bestStreak} ${ICONS.flame}</div><div class="lbl">Лучшая серия</div></div>
      </div>
    ` : `<div class="chat-empty">Загружаем статистику...</div>`}
    ${!isMe ? `<button class="btn-primary profile-dm-btn" id="profileDmBtn">${ICONS.chat} Написать в личку</button>` : ''}
  `;

  const dmBtn = document.getElementById('profileDmBtn');
  if (dmBtn) dmBtn.onclick = () => {
    closePlayerProfile();
    openChat('dm', member.id);
  };
}

/* ============ INIT ============ */
(async function init() {
  await tryRestoreSession();
  render();
})();
