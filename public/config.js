// Адрес бэкенда. Поменяй на адрес твоего задеплоенного сервера в проде,
// либо оставь как есть для локальной разработки (npm start в /server).
const API_BASE = (function () {
  const host = window.location.hostname;
  // When the beta is opened directly from the local server (including from
  // another device on the same Wi-Fi), use that exact origin instead of
  // resolving "localhost" on the phone.
  if (window.location.port === '3001') {
    return window.location.origin;
  }
  return 'https://virh-backend-4.onrender.com';
})();

const WS_BASE = API_BASE.replace(/^http/, 'ws');
