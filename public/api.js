const Api = (() => {
  function getToken() {
    return localStorage.getItem('vihr_token') || '';
  }
  function setToken(token) {
    if (token) localStorage.setItem('vihr_token', token);
    else localStorage.removeItem('vihr_token');
  }

  async function request(path, opts = {}) {
    const headers = opts.headers || {};
    if (!(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(API_BASE + path, { ...opts, headers });
    } catch (e) {
      const err = new Error('network');
      err.network = true;
      throw err;
    }

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }

    if (!res.ok) {
      const err = new Error((data && data.message) || (data && data.error) || 'request_failed');
      err.status = res.status;
      err.code = data && data.error;
      throw err;
    }
    return data;
  }

  return {
    getToken,
    setToken,

    register: (username, password, displayName) =>
      request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password, displayName }) }),

    login: (username, password) =>
      request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),

    me: () => request('/api/auth/me'),

    updateProfile: (patch) =>
      request('/api/auth/me', { method: 'PATCH', body: JSON.stringify(patch) }),

    uploadAvatar: (file) => {
      const fd = new FormData();
      fd.append('avatar', file);
      return request('/api/auth/me/avatar', { method: 'POST', body: fd });
    },

    deleteAvatar: () => request('/api/auth/me/avatar', { method: 'DELETE' }),

    changePassword: (currentPassword, newPassword) =>
      request('/api/auth/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),

    generateSoloQuestions: (payload) => request('/api/solo/questions', { method: 'POST', body: JSON.stringify(payload) }),

    generateTodPrompt: (payload) => request('/api/solo/truth-or-dare', { method: 'POST', body: JSON.stringify(payload) }),

    createRoom: (payload) => request('/api/rooms', { method: 'POST', body: JSON.stringify(payload) }),

    getRoom: (code) => request('/api/rooms/' + encodeURIComponent(code)),

    browseRooms: () => request('/api/rooms'),

    joinRoom: (code, password) => request('/api/rooms/' + encodeURIComponent(code) + '/join', { method: 'POST', body: JSON.stringify({ password: password || '' }) }),
    renameRoom: (code, name) => request('/api/rooms/' + encodeURIComponent(code), { method: 'PATCH', body: JSON.stringify({ name }) }),
    updateRoom: (code, patch) => request('/api/rooms/' + encodeURIComponent(code), { method: 'PATCH', body: JSON.stringify(patch) }),

    avatarFullUrl: (path) => (path ? API_BASE + path : null),
  };
})();
