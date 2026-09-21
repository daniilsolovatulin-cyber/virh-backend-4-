/* ============================================================
   Вихрь — фронтенд
   Вопросы для всех режимов генерируются сервером. Ключи провайдера
   остаются в окружении сервера и никогда не попадают в браузер игрока.
   ============================================================ */

/* ============ STATE ============ */
const state = {
  // auth
  user: null, // {id, username, displayName, avatarUrl, avatarEmoji, avatarColor}
  authError: '',
  authBusy: false,

  // theme / local settings
  theme: localStorage.getItem('quiz_theme') || 'auto',
  serviceAvailable: null,

  // routing
  view: 'home', // see viewHTML()
  authMode: 'login', // 'login' | 'register'

  // solo setup
  setupMode: null, // 'classic' | 'blitz'
  selectedTopic: '',
  customTopic: '',
  language: 'Русский',
  questionCount: 8,
  blitzSeconds: 60,
  questions: [],
  genProgress: 0,
  genTotal: 0,
  genStartedAt: 0, // когда началась генерация (для таймера сверху)
  genEtaMs: 0, // оценка «сколько осталось»
  genCancelled: false,
  genTicker: null,
  currentIndex: 0,
  score: 0,
  answered: null,
  timeLeft: 0,
  timerInterval: null,
  ageGroup: 'any',
  interest: '',
  // Kept in memory only. It disappears on refresh and is never stored in localStorage.
  generatorKey: '',
  exactFacts: true,

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
  myLastAnswerIdx: null, // which option this client picked for the current question
  pendingAdvance: null, // solo: timeout that moves to the next question
  roomSetup: { mode: 'classic', topic: '', customTopic: '', name: '', language: 'Русский', questionCount: 10, maxPlayers: 0 },
  roomGenStartedAt: 0, // с какого момента комната «готовит вопросы»
  browseRooms: [],
  browseRoomsLoading: false,
  browseRoomsError: '',
  roundStartShown: false,
};

const MAX_PLAYERS_OPTIONS = [0, 2, 4, 6, 8, 12]; // 0 = no limit

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

async function checkGeneratorStatus() {
  try {
    const health = await Api.health();
    state.serviceAvailable = !!health.groqConfigured;
  } catch (e) {
    state.serviceAvailable = false;
  }
  if (state.view === 'home') render();
}

function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

function genEtaLabel() {
  if (state.genEtaMs > 0) return 'осталось ≈ ' + formatClock(state.genEtaMs);
  if (state.genTotal && state.genProgress >= state.genTotal) return 'почти готово';
  return 'оцениваю время…';
}

function startGenTicker() {
  stopGenTicker();
  state.genTicker = setInterval(() => {
    const elapsed = document.getElementById('genElapsed');
    if (elapsed) elapsed.textContent = formatClock(Date.now() - state.genStartedAt);
    const eta = document.getElementById('genEta');
    if (eta) eta.textContent = genEtaLabel();
    const roomElapsed = document.getElementById('roomGenElapsed');
    if (roomElapsed) roomElapsed.textContent = formatClock(Date.now() - state.roomGenStartedAt);
  }, 500);
}

function stopGenTicker() {
  if (state.genTicker) { clearInterval(state.genTicker); state.genTicker = null; }
}

// Пока ИИ ищет вопросы, будущий экран показывается размытым: и данные вопроса,
// и подсказка темы видны, но прочитать их нельзя.
function genPreviewHTML(topicLabel) {
  const letters = ['A', 'B'];
  return `
    <div class="gen-preview" aria-hidden="true">
      <div class="panel question-card view">
        <div class="question-category">${ICONS.tag} ${escapeHtml(topicLabel || 'Викторина')}</div>
        <div class="question-text">Здесь появится вопрос, который придумает ИИ</div>
      </div>
      <div class="answers-grid compact">
        ${letters.map((l) => `<button class="answer-btn" disabled type="button"><span class="answer-letter">${l}</span><span>Вариант ответа</span></button>`).join('')}
      </div>
    </div>`;
}

function genToplineHTML() {
  return `
    <div class="gen-topline">
      <span class="gen-elapsed tabular" id="genElapsed">0:00</span>
      <span class="gen-eta" id="genEta">оцениваю время…</span>
      <button class="btn-ghost gen-cancel" id="genCancelBtn" type="button">Отменить</button>
    </div>`;
}

function avatarHTML(entity, size) {
  // entity: {avatarUrl, avatarEmoji, avatarColor, displayName}
  const cls = 'avatar' + (size ? ' ' + size : '');
  if (entity && entity.avatarUrl) {
    const url = Api.avatarFullUrl(entity.avatarUrl);
    return `<span class="${cls}"><img src="${url}" alt=""></span>`;
  }
  const rawColor = (entity && entity.avatarColor) || '';
  const color = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : '#3D3AF1';
  const emoji = (entity && entity.avatarEmoji) || '🙂';
  return `<span class="${cls}" style="background:${color}22;">${emoji}</span>`;
}

const ROOM_VIEWS = new Set(['roomLobby', 'roomPlay', 'roomResult']);

// Header's home/brand buttons are one click away from every screen, including mid-game —
// so leaving a room through them asks first instead of tearing the room down immediately.
// The explicit "Выйти из лобби/комнаты" buttons on the room screens themselves skip the
// confirm: clicking a button labeled "leave" is already the deliberate action.
function goHomeFromHeader() {
  if (ROOM_VIEWS.has(state.view) && state.room) {
    openLeaveRoomConfirm();
    return;
  }
  goHome();
}

function goHome() {
  stopTimer();
  state.genCancelled = true; // уход с экрана генерации прекращает запросы к Groq
  stopGenTicker();
  leaveCurrentRoom();
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
  openModal(document.getElementById('leaveRoomOverlay'));
}

function closeLeaveRoomConfirm() {
  closeModal(document.getElementById('leaveRoomOverlay'));
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
  state.wsAnswered = false;
  state.wsAnsweredUsers = [];
  state.myLastAnswerIdx = null;
  state.roundStartShown = false;
}

/* ============ RENDER: ROOT ============ */
// Глубина экрана нужна только для направления анимации: вперёд — влево, назад — вправо.
const VIEW_DEPTH = {
  home: 0, auth: 1, profile: 1, setup: 1, todSetup: 1, roomCreate: 1, roomJoin: 1,
  generating: 2, quiz: 2, tod: 2, roomLobby: 2, result: 3, roomPlay: 3, roomResult: 3,
};
let navDepth = 0;
let transitionRunning = false;
let renderedView = null;

function render() {
  const headerEl = document.getElementById('appHeader');
  const main = document.getElementById('appMain');
  // A timer tick, an answer, or a health check may re-render the same screen.
  // It must not look like the player navigated away and back again.
  const viewChanged = state.view !== renderedView;
  renderedView = state.view;

  const depth = VIEW_DEPTH[state.view] || 0;
  const goingBack = depth < navDepth;
  navDepth = depth;
  document.documentElement.dataset.nav = goingBack ? 'back' : 'forward';

  const swap = () => {
    // Шапка перерисовывается только при реальном изменении: раньше она
    // пересоздавалась на каждый render, из-за чего мигали аватар и иконки.
    const html = headerHTML();
    if (headerEl._html !== html) {
      headerEl.innerHTML = html;
      headerEl._html = html;
      bindHeader();
    }
    main.innerHTML = viewHTML();
    bindView();
    enhanceInteractiveElements();
  };

  // View Transitions даёт настоящее «перелистывание» целой страницы без вспышки.
  if (viewChanged && typeof document.startViewTransition === 'function' && !transitionRunning) {
    transitionRunning = true;
    const done = () => { transitionRunning = false; };
    document.startViewTransition(swap).finished.then(done, done);
    return;
  }

  swap();
  // Запасной вариант для браузеров без View Transitions.
  main.classList.remove('page-in');
  if (viewChanged) {
    void main.offsetWidth; // перезапуск анимации
    main.classList.add('page-in');
  }
}

function enhanceInteractiveElements() {
  document.querySelectorAll('.mode-card, .chip, .theme-opt, .emoji-opt, .color-opt').forEach((el) => {
    if (el.tagName === 'BUTTON' || typeof el.onclick !== 'function') return;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    if (el.classList.contains('chip') || el.classList.contains('theme-opt')) {
      el.setAttribute('aria-pressed', String(el.classList.contains('active')));
    }
    el.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        el.click();
      }
    };
  });
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
  if (acc) acc.onclick = () => { state.view = 'profile'; render(); };
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
    case 'generating': return bindGenerating();
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
      ${state.serviceAvailable === false ? '<p class="service-warning">Общий ключ генератора пока не подключён. Для одиночной игры можно вставить свой ключ на следующем экране; для комнат нужен ключ сервера.</p>' : ''}
    </div>

    <div class="section-label">С друзьями</div>
    <div class="mode-grid">
      <div class="mode-card featured view" data-mode="roomCreate">
        <div class="mode-badge">Онлайн</div>
        <div class="mode-title">Создать комнату</div>
        <div class="mode-desc">Общий счёт, вопросы для всех сразу, живой список игроков.</div>
      </div>
      <div class="mode-card view" data-mode="roomJoin">
        <div class="mode-icon">${ICONS.users}</div>
        <div>
          <div class="mode-title">Войти по коду</div>
          <div class="mode-desc">Есть код комнаты от друга — заходи прямо сюда.</div>
        </div>
      </div>
    </div>

    <div class="section-label">В одиночку</div>
    <div class="mode-grid">
      <div class="mode-card view" data-mode="classic">
        <div class="mode-icon">${ICONS.book}</div>
        <div>
          <div class="mode-title">Классика</div>
          <div class="mode-desc">Вопросы по теме, без спешки, с подсчётом верных ответов.</div>
        </div>
      </div>
      <div class="mode-card view" data-mode="blitz">
        <div class="mode-icon">${ICONS.bolt}</div>
        <div>
          <div class="mode-title">Блиц</div>
          <div class="mode-desc">Общий таймер на игру — успей ответить на максимум вопросов.</div>
        </div>
      </div>
    </div>

    <div class="section-label">Мини-игра</div>
    <div class="mode-grid">
      <div class="mode-card view" data-mode="tod">
        <div class="mode-icon">${ICONS.heart}</div>
        <div>
          <div class="mode-title">Правда или действие</div>
          <div class="mode-desc">Карточки на лету, для одного или компании до 4 человек по очереди.</div>
        </div>
      </div>
    </div>
  `;
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
            ${state.authBusy ? '<span class="spinner"></span>' : (isLogin ? ICONS.logIn : ICONS.user)}
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
  leaveCurrentRoom();
  state.view = 'home';
  render();
  showToast('Вы вышли из аккаунта');
}

/* ============ PROFILE ============ */
function profileHTML() {
  const u = state.user;
  if (!u) { state.view = 'auth'; return authHTML(); }
  return `
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

  document.getElementById('displayNameInput').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('saveNameBtn').click(); }
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

/* ============ SETTINGS MODAL (theme + local Groq keys) ============ */
function openSettings() {
  const overlay = document.getElementById('settingsOverlay');
  openModal(overlay);
  renderThemeRow();
}

let modalReturnFocus = null;
function openModal(overlay) {
  modalReturnFocus = document.activeElement;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => overlay.querySelector('[tabindex="-1"]').focus());
}

function closeModal(overlay) {
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') modalReturnFocus.focus();
  modalReturnFocus = null;
}

document.addEventListener('DOMContentLoaded', () => {
  checkGeneratorStatus();
  document.getElementById('closeSettings').onclick = () => closeModal(document.getElementById('settingsOverlay'));
  document.getElementById('settingsOverlay').onclick = (e) => {
    if (e.target.id === 'settingsOverlay') closeModal(e.currentTarget);
  };

  document.getElementById('closeLeaveRoomModal').onclick = closeLeaveRoomConfirm;
  document.getElementById('stayInRoomBtn').onclick = closeLeaveRoomConfirm;
  document.getElementById('confirmLeaveRoomBtn').onclick = confirmLeaveRoom;
  document.getElementById('leaveRoomOverlay').onclick = (e) => {
    if (e.target.id === 'leaveRoomOverlay') closeLeaveRoomConfirm();
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('leaveRoomOverlay').classList.contains('open')) closeLeaveRoomConfirm();
    closeModal(document.getElementById('settingsOverlay'));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const overlay = document.querySelector('.modal-overlay.open');
    if (!overlay) return;
    const focusable = [...overlay.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // Ответы с клавиатуры: 1-4 или A-D на любом экране с вариантами (одиночная игра и комната).
  const ANSWER_KEYS = { '1': 0, '2': 1, '3': 2, '4': 3, a: 0, b: 1, c: 2, d: 3 };
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const idx = ANSWER_KEYS[e.key.toLowerCase()];
    if (idx === undefined) return;
    const btn = document.querySelectorAll('.answer-btn')[idx];
    if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
  });
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
    opt.setAttribute('aria-pressed', String(opt.dataset.themeChoice === state.theme));
    opt.onclick = () => {
      state.theme = opt.dataset.themeChoice;
      localStorage.setItem('quiz_theme', state.theme);
      applyTheme();
      renderThemeRow();
    };
  });
}

/* ============ SOLO GENERATION VIA SERVER ============ */

async function generateQuestionsLocal(topic, language, count, onProgress, ageGroup, apiKey, exactFacts) {
  onProgress(0, count, exactFacts ? 'Ищу даты и числа в открытых источниках…' : 'Подключаю библиотеку вопросов…');
  const result = await Api.generateSoloQuestions({ topic, language, count, ageGroup, apiKey, exactFacts });
  onProgress(result.questions.length, count, 'Вопросы готовы');
  return result.questions;
}

async function generateTodPromptLocal(type, language, ageGroup, interest, onProgress) {
  try {
    if (onProgress) onProgress(1, 4, 'Подбираю карточку…');
    const result = await Api.generateTodPrompt({ type, language, ageGroup, interest, apiKey: state.generatorKey });
    if (onProgress) onProgress(4, 4, 'Готово');
    return result.text;
  } catch (e) {
    if (onProgress) onProgress(4, 4, 'Готово');
    return type === 'truth' ? 'Какой твой самый нелепый страх?' : 'Изобрази своё животное на выбор без слов.';
  }
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

      <div class="field fact-mode">
        <label>Формат вопросов</label>
        <button class="fact-toggle ${state.exactFacts ? 'active' : ''}" type="button" id="exactFactsToggle" aria-pressed="${state.exactFacts}">
          <span class="fact-toggle-mark">${state.exactFacts ? '✓' : ''}</span>
          <span><strong>Точные даты и числа</strong><small>Ищу факты в открытых источниках перед генерацией</small></span>
        </button>
      </div>

      <div class="field key-field">
        <label for="generatorKeyInput">Ключ генератора <span class="label-optional">необязательно</span></label>
        <input type="password" id="generatorKeyInput" autocomplete="off" spellcheck="false" placeholder="gsk_…" value="${escapeHtml(state.generatorKey)}">
        <p class="hint">Нужен, если общий генератор временно недоступен. Используется только для этого запуска и не сохраняется.</p>
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

  document.getElementById('startBtn').onclick = async () => {
    const topic = state.customTopic.trim() || state.selectedTopic;
    if (!topic) { showToast('Выбери или введи тему', ICONS.tag); return; }
    state.genCancelled = false;
    state.genStartedAt = Date.now();
    state.genEtaMs = 0;
    state.genProgress = 0;
    state.view = 'generating';
    render();
    try {
      const count = state.setupMode === 'blitz' ? 30 : state.questionCount;
      const qs = await generateQuestionsLocal(topic, state.language, count, (done, total, label) => {
        state.genProgress = done;
        state.genTotal = total;
        updateGenProgress(label);
      }, state.ageGroup, state.generatorKey, state.exactFacts);
      stopGenTicker();
      if (state.view !== 'generating') return; // пользователь ушёл с экрана генерации
      if (!qs.length) throw new Error('empty');
      state.questions = qs;
      state.currentIndex = 0;
      state.score = 0;
      state.answered = null;
      state.view = 'quiz';
      render();
      if (state.setupMode === 'blitz') startBlitzTimer();
    } catch (err) {
      stopGenTicker();
      if (err && err.message === 'cancelled') return; // пользователь сам нажал «Отменить»
      console.error('Ошибка генерации вопросов:', err);
      let msg = 'Не удалось сгенерировать вопросы';
      if (err && err.status === 429) msg = 'Сейчас слишком много новых викторин. Попробуй чуть позже.';
      else if (err && err.status === 503) msg = 'Генератор временно недоступен. Попробуй ещё раз.';
      else if (err && err.status) msg = 'Сервис не смог подготовить вопросы.';
      else if (err && /fetch|network|Failed to fetch/i.test(err.message || '')) msg = 'Нет связи с сервисом. Проверь подключение.';
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
  const topic = state.customTopic.trim() || state.selectedTopic || 'Викторина';
  return `
    ${genToplineHTML()}
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
      <div class="gen-sub">Проверяю факты, формулировки и варианты ответов</div>
      ${genPreviewHTML(topic)}
    </div>
  `;
}

function bindGenerating() {
  const cancel = document.getElementById('genCancelBtn');
  if (cancel) cancel.onclick = () => {
    state.genCancelled = true;
    stopGenTicker();
    state.view = 'setup';
    render();
  };
  startGenTicker();
}

function updateGenProgress(label) {
  const pct = state.genTotal ? Math.round((state.genProgress / state.genTotal) * 100) : 0;
  if (state.genProgress > 0 && state.genProgress < state.genTotal) {
    state.genEtaMs = Math.max(0, ((Date.now() - state.genStartedAt) / state.genProgress) * (state.genTotal - state.genProgress));
  } else if (state.genProgress >= state.genTotal) {
    state.genEtaMs = 0;
  }
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
  return `
    <div class="quiz-topline">
      <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>
      ${state.setupMode === 'blitz'
        ? `<span class="timer-badge" id="timerBadge">${ICONS.clock} ${state.timeLeft}с</span>`
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
    <button class="btn-ghost room-leave-btn" id="leaveQuizBtn">${ICONS.cross} Выйти из викторины</button>
  `;
}

function bindQuiz() {
  document.querySelectorAll('.answer-btn').forEach((btn) => {
    btn.onclick = () => selectAnswer(parseInt(btn.dataset.idx, 10));
  });
  const leave = document.getElementById('leaveQuizBtn');
  if (leave) leave.onclick = () => {
    clearTimeout(state.pendingAdvance);
    state.pendingAdvance = null;
    state.answered = null;
    goHome();
  };
}

function selectAnswer(idx) {
  if (state.answered !== null) return;
  const q = state.questions[state.currentIndex];
  state.answered = idx;
  const correct = q.correct;

  document.querySelectorAll('.answer-btn').forEach((btn, i) => {
    btn.disabled = true;
    if (i === correct) btn.classList.add('correct');
    else if (i === idx) btn.classList.add('wrong');
  });

  if (idx === correct) {
    state.score++;
    const scoreBadge = document.querySelector('.score-badge');
    if (scoreBadge) scoreBadge.innerHTML = ICONS.trophy + ' ' + state.score;
  }

  clearTimeout(state.pendingAdvance);
  state.pendingAdvance = setTimeout(() => nextQuestion(), 1100);
}

function nextQuestion() {
  // The blitz timer may have finished the quiz while this timeout was pending —
  // without this guard the quiz screen was drawn on top of the result screen.
  if (state.view !== 'quiz') return;
  if (state.currentIndex + 1 >= state.questions.length) { finishQuiz(); return; }
  state.currentIndex++;
  state.answered = null;
  const main = document.getElementById('appMain');
  main.innerHTML = quizHTML();
  bindQuiz();
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
    if (state.timeLeft <= 0) { stopTimer(); finishQuiz(); }
  }, 1000);
}

function stopTimer() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
}

function finishQuiz() {
  stopTimer();
  clearTimeout(state.pendingAdvance);
  state.pendingAdvance = null;
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

      <div class="field">
        <label>Лимит игроков</label>
        <div class="chip-row" id="roomMaxPlayersChips">
          ${MAX_PLAYERS_OPTIONS.map((n) => `<div class="chip ${(s.maxPlayers || 0) === n ? 'active' : ''}" data-max="${n}">${n === 0 ? 'Без лимита' : n}</div>`).join('')}
        </div>
        <div class="field-hint">Можно поменять позже прямо в лобби.</div>
      </div>

      <button class="btn-primary" id="roomCreateBtn" ${state.roomBusy ? 'disabled' : ''}>
        ${state.roomBusy ? '<span class="spinner"></span>' : ICONS.plus}
        Создать комнату
      </button>
    </div>
  `;
}

function bindRoomCreate() {
  document.querySelectorAll('#roomModeChips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.roomSetup.mode = chip.dataset.mode;
      document.querySelectorAll('#roomModeChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
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

  document.getElementById('roomNameInput').oninput = (e) => { state.roomSetup.name = e.target.value; };

  document.getElementById('roomLanguageSelect').onchange = (e) => { state.roomSetup.language = e.target.value; };

  document.querySelectorAll('#roomCountChips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.roomSetup.questionCount = parseInt(chip.dataset.count, 10);
      document.querySelectorAll('#roomCountChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
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

    state.roomBusy = true;
    render();
    try {
      // s.name already holds what the host typed (kept in sync by the input handler) —
      // reading it back from the DOM here returned the re-rendered, empty field.
      s.name = (s.name || '').trim();
      const { room } = await Api.createRoom({
        mode: s.mode,
        topic,
        language: s.language,
        questionCount: s.questionCount,
        maxPlayers: s.maxPlayers || 0,
        name: s.name || topic,
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
          <input type="text" id="roomCodeInput" value="${escapeHtml(state.roomJoinCode || '')}" placeholder="Например, K7QX9" maxlength="8" style="text-transform:uppercase; letter-spacing:0.08em; font-weight:700;" autocomplete="off" required>
        </div>
        <button class="btn-primary" id="roomJoinBtn" type="submit" style="width:auto; padding:0 18px;" ${state.roomBusy ? 'disabled' : ''}>
          ${state.roomBusy ? '<span class="spinner"></span>' : ICONS.arrowRight}
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
    return `<div class="empty-state" style="padding:24px;"><span class="spinner"></span></div>`;
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
      ${rooms.map((r) => `
        <div class="panel room-browse-row" data-code="${escapeHtml(r.code)}">
          <div class="room-browse-main">
            <div class="room-browse-name">${escapeHtml(r.name || r.topic)}</div>
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
  state.browseRoomsLoading = true;
  state.browseRoomsError = '';
  const wrap = document.getElementById('browseRoomsWrap');
  if (wrap) wrap.innerHTML = browseRoomsListHTML();
  try {
    const { rooms } = await Api.browseRooms();
    state.browseRooms = rooms;
  } catch (err) {
    state.browseRooms = [];
    state.browseRoomsError = err.network ? 'Не удалось связаться с сервером.' : 'Не получилось загрузить список комнат.';
  }
  state.browseRoomsLoading = false;
  const wrap2 = document.getElementById('browseRoomsWrap');
  if (wrap2) wrap2.innerHTML = browseRoomsListHTML();
  bindBrowseRoomsList();
}

function bindBrowseRoomsList() {
  document.querySelectorAll('.room-browse-join').forEach((btn) => {
    btn.onclick = () => joinRoomByCode(btn.dataset.code);
  });
}

async function joinRoomByCode(code) {
  if (!code) return;
  state.roomError = '';
  state.roomBusy = true;
  render();
  try {
    const { room } = await Api.joinRoom(code);
    state.room = room;
    state.roomBusy = false;
    state.roomJoinCode = '';
    connectRoomSocket(room.code);
    state.view = 'roomLobby';
    render();
  } catch (err) {
    state.roomBusy = false;
    state.roomError = roomErrorMessage(err);
    render();
  }
}

let browseRoomsTimer = null;
function bindRoomJoin() {
  const codeInput = document.getElementById('roomCodeInput');
  codeInput.oninput = (e) => { state.roomJoinCode = e.target.value; };
  document.getElementById('roomJoinForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = codeInput.value.trim().toUpperCase();
    if (!code) return;
    state.roomJoinCode = code;
    joinRoomByCode(code);
  };
  const refreshBtn = document.getElementById('refreshRoomsBtn');
  if (refreshBtn) refreshBtn.onclick = () => loadBrowseRooms();

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
  return 'Не получилось войти в комнату.';
}

/* ============ ROOMS: WEBSOCKET CLIENT ============ */
function connectRoomSocket(code) {
  disconnectRoomSocket();
  state.wsQuestion = null;
  state.wsDeadline = 0;
  stopRoomTimer();
  state.wsAnswered = false;
  state.wsAnsweredUsers = [];
  state.wsReveal = null;
  state.wsLeaderboard = null;
  state.roundStartShown = false;
  state.roomGenStartedAt = Date.now();

  const token = Api.getToken();
  const ws = new WebSocket(`${WS_BASE}/ws/room?token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`);
  state.ws = ws;

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    handleRoomMessage(msg);
  };

  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
    stopRoomTimer();
    Sound.stopMusic({ fade: false });
  };

  ws.onerror = () => {};
}

function disconnectRoomSocket() {
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
    case 'lobby_update':
      state.roomMembers = msg.members;
      if (msg.room && state.room) {
        state.room.name = msg.room.name;
        if (msg.room.hostUserId) state.room.hostUserId = msg.room.hostUserId;
        state.room.maxPlayers = msg.room.maxPlayers || 0;
      }
      if (state.view === 'roomLobby') { document.getElementById('appMain').innerHTML = roomLobbyHTML(); bindRoomLobby(); }
      break;

    case 'status':
      if (state.room) state.room.status = msg.status;
      if (msg.status === 'generating') state.roomGenStartedAt = Date.now();
      else stopGenTicker();
      if (msg.status === 'generating' && state.view === 'roomLobby') {
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
      break;

    case 'question':
      state.wsQuestion = msg;
      state.wsDeadline = msg.deadline || (Date.now() + 20000);
      state.wsAnswered = false;
      state.wsAnsweredUsers = [];
      state.wsReveal = null;
      state.myLastAnswerIdx = null;
      if (msg.index === 0 && !state.roundStartShown) {
        // First question of a fresh game: run the countdown, then reveal the round.
        state.roundStartShown = true;
        state.wsQuestion = null; // hold the question off-screen until the countdown finishes
        state.view = 'roomPlay';
        render();
        const socketAtStart = state.ws;
        playRoundStartSequence(() => {
          // The player can leave (or a new game can start) while the countdown runs —
          // redrawing here used to crash on state.room === null.
          if (state.ws !== socketAtStart || state.view !== 'roomPlay' || !state.room) return;
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
      // The server ships fresh totals with every reveal; without applying them the score
      // badge stayed frozen at its pre-game value for the whole match.
      if (Array.isArray(msg.scores)) {
        msg.scores.forEach((s) => {
          const m = (state.roomMembers || []).find((x) => x.id === s.userId);
          if (m) m.score = s.score;
        });
      }
      if (state.user && Array.isArray(msg.answers)) {
        const mine = msg.answers.find((a) => a.userId === state.user.id);
        if (mine) { mine.isCorrect ? Sound.correct() : Sound.wrong(); }
      }
      if (state.view === 'roomPlay') { document.getElementById('appMain').innerHTML = roomPlayHTML(); bindRoomPlay(); }
      break;

    case 'game_over':
      state.wsLeaderboard = msg.leaderboard;
      state.roundStartShown = false;
      Sound.stopMusic();
      state.view = 'roomResult';
      render();
      break;

    case 'error':
      showToast(msg.message === 'room_not_found' ? 'Комната не найдена' : (msg.message || 'Ошибка комнаты'), ICONS.cross);
      break;
  }
}

/* ============ ROOMS: LOBBY ============ */
function roomLobbyHTML() {
  const room = state.room;
  if (!room) return `<div class="empty-state">${ICONS.users}<div class="title">Комната не найдена</div></div>`;

  const isHost = state.user && room.hostUserId === state.user.id;
  const generating = room.status === 'generating';
  const members = state.roomMembers || [];

  return `
    <div class="panel room-code-banner view">
      <div>
        <div class="lbl">${escapeHtml(room.name || 'Лобби')} · код для друзей</div>
        <div class="code tabular">${escapeHtml(room.code)}</div>
      </div>
      <button class="btn-ghost" id="copyCodeBtn">${ICONS.copy} Скопировать</button>
    </div>

    <div class="section-label">Название лобби</div>
    <div class="panel" style="padding:14px 18px; display:flex; justify-content:space-between; align-items:center;">
      <span style="font-weight:600;">${escapeHtml(room.name || '—')}</span>
      ${isHost ? '<button class="btn-ghost" id="renameRoomBtn">Изменить</button>' : ''}
    </div>

    <div class="section-label">Тема</div>
    <div class="panel" style="padding:14px 18px; display:flex; justify-content:space-between; align-items:center;">
      <span style="font-weight:600;">${escapeHtml(room.topic || '—')}</span>
      <span class="chip" style="cursor:default;">${room.mode === 'blitz' ? 'Блиц' : 'Классика'} · ${room.questionCount} вопр.</span>
    </div>

    <div class="section-label">Игроки (${members.length}${room.maxPlayers ? ' / ' + room.maxPlayers : ''})</div>
    <div class="member-list">
      ${members.map((m) => `
        <div class="member-row">
          ${avatarHTML(m, 'md')}
          <span class="name">${escapeHtml(m.displayName)}</span>
          ${m.id === room.hostUserId ? `<span class="role-tag">Хост</span>` : ''}
        </div>
      `).join('')}
    </div>

    ${isHost ? `
    <div class="section-label">Лимит игроков</div>
    <div class="chip-row" id="lobbyMaxPlayersChips" style="margin-bottom:4px;">
      ${MAX_PLAYERS_OPTIONS.map((n) => `<div class="chip ${(room.maxPlayers || 0) === n ? 'active' : ''}" data-max="${n}">${n === 0 ? 'Без лимита' : n}</div>`).join('')}
    </div>
    ` : ''}

    <div style="margin-top:22px;">
      ${generating
        ? `<div class="gen-status">${isHost ? 'Готовлю вопросы…' : 'Хост готовит вопросы…'}</div>
           <div class="gen-sub">Прошло <span class="tabular" id="roomGenElapsed">0:00</span> · обычно 10–30 секунд</div>
           ${genPreviewHTML(room.topic)}`
        : isHost
          ? `<button class="btn-primary" id="startRoomGameBtn" ${members.length < 1 ? 'disabled' : ''}>${ICONS.arrowRight} Начать игру</button>`
          : `<div class="empty-state" style="padding:16px;"><div class="sub">Ждём, пока хост начнёт игру.</div></div>`
      }
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
  document.querySelectorAll('#lobbyMaxPlayersChips .chip').forEach((chip) => {
    chip.onclick = () => {
      sendRoomMessage({ type: 'set_max_players', maxPlayers: parseInt(chip.dataset.max, 10) });
      document.querySelectorAll('#lobbyMaxPlayersChips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    };
  });
  const leaveBtn = document.getElementById('leaveLobbyBtn');
  if (leaveBtn) leaveBtn.onclick = () => goHome();
  // таймер «сколько уже готовятся вопросы» живёт, только пока лобби в этом статусе
  if (state.room && state.room.status === 'generating') startGenTicker();
  else stopGenTicker();
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
    return `<div class="panel gen-wrap view">${todGeneratingHTML(0, 4, 'Готовим вопросы...')}${genPreviewHTML(state.room && state.room.topic)}</div>`;
  }

  const progressPct = Math.round((q.index / q.total) * 100);
  const reveal = state.wsReveal && state.wsReveal.index === q.index ? state.wsReveal : null;
  const myScore = ((state.roomMembers || []).find((m) => state.user && m.id === state.user.id) || {}).score || 0;
  const secondsLeft = state.wsDeadline ? Math.max(0, Math.ceil((state.wsDeadline - Date.now()) / 1000)) : 0;

  return `
    <div class="quiz-topline">
      <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>
      <span class="quiz-counter">${q.index + 1} / ${q.total}</span>
      <span class="timer-badge" id="roomTimerBadge">${ICONS.clock} ${secondsLeft}с</span>
      <span class="score-badge">${ICONS.trophy} ${myScore}</span>
    </div>
    <div class="panel question-card view">
      <div class="question-category">${ICONS.tag} ${escapeHtml((state.room && state.room.topic) || 'Викторина')}</div>
      <div class="question-text">${escapeHtml(q.question.question)}</div>
    </div>
    <div class="answers-grid">
      ${q.question.options.map((opt, i) => {
        // One source of truth for the button state: the class used to be computed twice,
        // and the inline copy is what actually ended up in the markup.
        let cls = 'answer-btn';
        if (reveal) {
          if (i === reveal.correct) cls += ' correct';
          else if (state.myLastAnswerIdx === i) cls += ' wrong';
        } else if (state.wsAnswered && state.myLastAnswerIdx === i) {
          cls += ' picked';
        }
        const votersHTML = reveal ? answerVotersHTML(reveal, i) : '';
        return `
        <button class="${cls}"
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
    .map((m) => `<span class="answered-pill">${ICONS.check} ${escapeHtml(m.displayName)}</span>`)
    .join('');
}

function updateAnsweredPills() {
  const el = document.getElementById('answeredOthers');
  if (el) el.innerHTML = answeredPillsHTML();
}

function answerVotersHTML(reveal, optionIdx) {
  const voters = reveal.answers.filter((a) => a.optionIdx === optionIdx);
  if (!voters.length) return '';
  return `
    <div class="answer-voters">
      ${voters.map((a) => `
        <span class="voter-pill ${a.isCorrect ? 'voter-correct' : 'voter-wrong'}">
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
      btn.classList.add('picked'); // neutral marker — the reveal decides right/wrong
      sendRoomMessage({ type: 'submit_answer', questionIdx: state.wsQuestion.index, optionIdx: idx });
    };
  });
  const leaveBtn = document.getElementById('leavePlayBtn');
  if (leaveBtn) leaveBtn.onclick = () => goHome();
}

/* ============ ROOMS: RESULT ============ */
function roomResultHTML() {
  const board = state.wsLeaderboard || [];
  return `
    <div class="panel result-hero view">
      <div style="font-size:34px; margin-bottom:6px;">${ICONS.trophy}</div>
      <div class="result-title">Игра окончена</div>
      <div class="result-sub">Итоговая таблица результатов</div>
      <div style="text-align:left; max-width:360px; margin:0 auto 22px;">
        ${board.map((m, i) => `
          <div class="leaderboard-row ${i === 0 ? 'first' : ''}">
            <span style="display:flex; align-items:center; gap:10px;">
              <span class="leaderboard-rank">${i + 1}</span>
              ${avatarHTML(m, 'md')}
              <span style="font-weight:600;">${escapeHtml(m.displayName)}</span>
            </span>
            <span class="tabular" style="font-weight:700;">${m.score}</span>
          </div>
        `).join('')}
      </div>
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
}

/* ============ INIT ============ */
(async function init() {
  await tryRestoreSession();
  render();
})();
