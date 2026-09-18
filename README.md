# Vihr — сервер (backend)

Node.js + Express + SQLite (better-sqlite3) + WebSocket (ws).
Отвечает за: регистрацию/вход, профиль с аватаром, комнаты и live-мультиплеер.

## Запуск локально

```bash
cd server
npm install
cp .env.example .env
```

Открой `.env` и заполни:

```
PORT=3001
JWT_SECRET=любая_длинная_случайная_строка
GROQ_API_KEYS=gsk_твой_ключ_1,gsk_твой_ключ_2
CORS_ORIGIN=http://localhost:5173
```

`GROQ_API_KEYS` — один или несколько ключей через запятую (сервер сам ротирует их при 429/401).
Ключи Groq: https://console.groq.com/keys

Запуск:

```bash
npm start
```

Сервер поднимется на `http://localhost:3001`. База данных — файл `db/vihr.sqlite`, создаётся автоматически при первом запуске.

Проверка, что всё живо:

```bash
curl http://localhost:3001/api/health
```

## Структура

- `index.js` — точка входа, Express + HTTP-сервер + WebSocket upgrade
- `db/init.js` — схема SQLite (users, rooms, room_members, room_answers)
- `auth.js` — JWT подпись/проверка
- `routes/auth.js` — регистрация, вход, профиль, аватар (загрузка файла)
- `routes/rooms.js` — создание комнаты, получение по коду, вход в комнату
- `realtime.js` — вся live-логика: лобби, старт игры, вопросы, ответы, счёт, реванш
- `questionGen.js` — генерация вопросов через Groq (ключи только на сервере)

## Деплой

Подойдёт любой хостинг с постоянным процессом и поддержкой WebSocket:
Railway, Render, Fly.io, обычный VPS. Важно:

- Не использовать serverless-платформы без поддержки WebSocket (Vercel functions и т.п. не подойдут для `realtime.js`).
- Смонтировать постоянный диск под `db/vihr.sqlite` и `uploads/avatars/`, иначе при рестарте контейнера данные потеряются (на Railway/Render это "volume" в настройках сервиса).
- Задать `CORS_ORIGIN` = адрес, на котором будет жить фронтенд.
- Задать `JWT_SECRET` на что-то длинное и случайное, не оставлять дефолт.

## API кратко

- `POST /api/auth/register` `{username, password, displayName}` → `{token, user}`
- `POST /api/auth/login` `{username, password}` → `{token, user}`
- `GET /api/auth/me` (Bearer token) → `{user}`
- `PATCH /api/auth/me` `{displayName?, avatarEmoji?, avatarColor?}` → `{user}`
- `POST /api/auth/me/avatar` (multipart, поле `avatar`) → `{user}`
- `DELETE /api/auth/me/avatar` → `{user}`
- `POST /api/rooms` `{mode, topic, language, questionCount}` → `{room}` (создатель авто-входит)
- `GET /api/rooms/:code` → `{room, members}`
- `POST /api/rooms/:code/join` → `{room}`
- `WS /ws/room?token=...&code=...` — реалтайм-канал комнаты, см. `realtime.js` для формата сообщений
