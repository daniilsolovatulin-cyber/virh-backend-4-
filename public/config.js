// Адрес бэкенда.
//
// Порядок выбора:
//   1. window.VIHR_API_BASE — если задан вручную (например, в отдельном <script> перед этим файлом);
//   2. если страница открыта с локального/домашнего адреса — тот же origin (когда фронтенд раздаёт
//      сам Express-сервер на любом порту), либо <host>:3001 (когда фронт поднят отдельно, напр. npx serve -l 5173);
//   3. иначе — задеплоенный бэкенд.
//
// ВАЖНО: адрес ниже должен совпадать с реальным адресом сервиса на Render
// (в render.yaml сервис называется vihr-api) — проверь его перед деплоем.
const API_BASE = (function () {
  if (typeof window.VIHR_API_BASE === 'string' && window.VIHR_API_BASE) {
    return window.VIHR_API_BASE.replace(/\/$/, '');
  }

  const { hostname, port, protocol, origin } = window.location;
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  const isPrivateNet = /^192\.168\./.test(hostname) || /^10\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);

  if (protocol !== 'file:' && (isLocalHost || isPrivateNet)) {
    // "npx serve -l 5173" serves the static frontend only, so the API lives one port over.
    if (port === '5173') return protocol + '//' + hostname + ':3001';
    // Anything else local is the Express server itself, which serves both API and frontend.
    return origin;
  }

  // When Express serves the frontend (the production setup), the API is on the
  // same origin. A separately hosted frontend can still provide VIHR_API_BASE.
  if (protocol !== 'file:') return origin;

  return 'https://virh-backend-4.onrender.com';
})();

const WS_BASE = API_BASE.replace(/^http/, 'ws');
