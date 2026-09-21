/* ============================================================
   Вихрь — звуковой модуль
   SFX синтезируются на Web Audio (без файлов).
   Музыка — шафл-плейлист из 3 классических треков, крутится
   на фоне игры, зацикливается, следующий трек выбирается
   случайно (без повтора того же трека два раза подряд).
   ============================================================ */

const Sound = (function () {
  const MUSIC_TRACKS = [
    'audio/music/track-1.mp3',
    'audio/music/track-2.mp3',
    'audio/music/track-3.mp3',
  ];

  // localStorage can hold anything (older version, manual edit) — never let it throw.
  const prefs = (function () {
    try {
      const parsed = JSON.parse(localStorage.getItem('quiz_sound_prefs') || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  })();
  const state = {
    muted: prefs.muted === true,
    sfxVolume: typeof prefs.sfxVolume === 'number' ? prefs.sfxVolume : 0.7,
    musicVolume: typeof prefs.musicVolume === 'number' ? prefs.musicVolume : 0.35,
    ctx: null,
    musicEl: null,
    musicPlaylist: [],
    musicIdx: -1,
    musicFadeTimer: null,
    lastTrackIdx: -1,
  };

  function savePrefs() {
    localStorage.setItem('quiz_sound_prefs', JSON.stringify({
      muted: state.muted,
      sfxVolume: state.sfxVolume,
      musicVolume: state.musicVolume,
    }));
  }

  function ctx() {
    if (!state.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      state.ctx = new AC();
    }
    if (state.ctx.state === 'suspended') state.ctx.resume();
    return state.ctx;
  }

  // Unlocks the AudioContext on first user gesture (mobile autoplay policy).
  function unlock() {
    try { ctx(); } catch (e) {}
    document.removeEventListener('pointerdown', unlock);
    document.removeEventListener('keydown', unlock);
  }
  document.addEventListener('pointerdown', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });

  /* ---------- SFX: small synthesized tones, minimalist ---------- */
  function tone({ freq = 440, duration = 0.12, type = 'sine', gain = 0.2, glideTo = null, delay = 0 }) {
    if (state.muted) return;
    const c = ctx();
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + duration);
    const g = gain * state.sfxVolume;
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(g, t0 + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(amp).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function click() {
    tone({ freq: 720, duration: 0.05, type: 'sine', gain: 0.16 });
  }

  function tick(strong) {
    tone({ freq: strong ? 880 : 660, duration: strong ? 0.09 : 0.06, type: 'sine', gain: strong ? 0.28 : 0.18 });
  }

  function go() {
    // two-note rising "go" stab — minimalist, no gradient of tones, just a clean interval
    tone({ freq: 523.25, duration: 0.11, type: 'triangle', gain: 0.3 });
    tone({ freq: 784.0, duration: 0.22, type: 'triangle', gain: 0.32, delay: 0.09 });
  }

  function correct() {
    tone({ freq: 587.33, duration: 0.09, type: 'sine', gain: 0.26 });
    tone({ freq: 880.0, duration: 0.18, type: 'sine', gain: 0.26, delay: 0.08 });
  }

  function wrong() {
    tone({ freq: 220, duration: 0.22, type: 'sawtooth', gain: 0.18, glideTo: 140 });
  }

  function notify() {
    tone({ freq: 660, duration: 0.07, type: 'sine', gain: 0.2 });
    tone({ freq: 990, duration: 0.09, type: 'sine', gain: 0.2, delay: 0.06 });
  }

  /* ---------- Music: shuffle + loop over the classical playlist ---------- */
  function pickNextTrackIdx() {
    if (MUSIC_TRACKS.length === 1) return 0;
    let idx;
    do { idx = Math.floor(Math.random() * MUSIC_TRACKS.length); }
    while (idx === state.lastTrackIdx);
    return idx;
  }

  function ensureMusicEl() {
    if (state.musicEl) return state.musicEl;
    const el = new Audio();
    el.preload = 'auto';
    el.addEventListener('ended', playNextTrack);
    state.musicEl = el;
    return el;
  }

  function playNextTrack() {
    const el = ensureMusicEl();
    const idx = pickNextTrackIdx();
    state.lastTrackIdx = idx;
    el.src = MUSIC_TRACKS[idx];
    el.volume = state.muted ? 0 : state.musicVolume;
    el.currentTime = 0;
    el.play().catch(() => {}); // ignored if blocked pre-gesture; resumes on next user action
  }

  function startMusic() {
    if (state.muted) return;
    const el = ensureMusicEl();
    if (!el.src || el.paused) playNextTrack();
  }

  function stopMusic({ fade = true } = {}) {
    const el = state.musicEl;
    if (!el) return;
    clearTimeout(state.musicFadeTimer);
    if (!fade) { el.pause(); return; }
    const startVol = el.volume;
    const steps = 10;
    let i = 0;
    const fadeStep = () => {
      i++;
      el.volume = Math.max(0, startVol * (1 - i / steps));
      if (i >= steps) { el.pause(); el.volume = state.muted ? 0 : state.musicVolume; return; }
      state.musicFadeTimer = setTimeout(fadeStep, 60);
    };
    fadeStep();
  }

  function setMuted(muted) {
    state.muted = muted;
    if (state.musicEl) state.musicEl.volume = muted ? 0 : state.musicVolume;
    if (!muted && state.musicEl && state.musicEl.paused && state.musicEl.src) state.musicEl.play().catch(() => {});
    savePrefs();
  }

  function setMusicVolume(v) {
    state.musicVolume = Math.max(0, Math.min(1, v));
    if (state.musicEl && !state.muted) state.musicEl.volume = state.musicVolume;
    savePrefs();
  }

  function setSfxVolume(v) {
    state.sfxVolume = Math.max(0, Math.min(1, v));
    savePrefs();
  }

  return {
    click, tick, go, correct, wrong, notify,
    startMusic, stopMusic,
    isMuted: () => state.muted,
    setMuted,
    getSfxVolume: () => state.sfxVolume,
    getMusicVolume: () => state.musicVolume,
    setMusicVolume,
    setSfxVolume,
  };
})();
