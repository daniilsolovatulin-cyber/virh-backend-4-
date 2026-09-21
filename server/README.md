# Vihr — сервер (backend)

Node.js + Express + SQLite (better-sqlite3) + WebSocket (ws).
Отвечает за: регистрацию/вход, профиль с аватаром, комнаты и live-мультиплеер.

Требуется **Node.js 20+**. На Node 24 обязательна ветка `better-sqlite3` 12.x:
версия 11.x падает с нативной ошибкой `Assertion failed: (env) != nullptr`
(подробности в [../CHANGELOG.md](../CHANGELOG.md)).

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

`GROQ_API_KEYS` — один или несколько ключей через запятую (сервер сам ротирует их при 429/401). Это общий пул для комнат и одиночной игры: игроки не вводят и не видят ключи в браузере.
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

## Тесты

```bash
npm test
```

Два смоук-набора, внешних сервисов не требуют (Groq подменяется заглушкой):

- `test/rooms.smoke.js` — комнаты и реалтайм целиком: REST + WebSocket, ход игры,
  счета, реванш, передача хоста, устойчивость к битому WS-кадру;
- `test/frontend.smoke.js` — фронтенд без браузера: отрисовка всех экранов на заглушке DOM,
  таймеры генерации, размытие и бесконечное ожидание лимита Groq.

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
- `POST /api/solo/questions` `{topic, language, count, ageGroup}` → `{questions}` (гостевая одиночная игра, с ограничением частоты)
- `POST /api/solo/truth-or-dare` `{type, language, ageGroup, interest}` → `{text}`
- `GET /api/rooms/:code` → `{room, members}`
- `POST /api/rooms/:code/join` → `{room}`
- `WS /ws/room?token=...&code=...` — реалтайм-канал комнаты, см. `realtime.js` для формата сообщений

Поведение в игре:

- Время на вопрос зависит от режима комнаты: классика — 20 секунд, блиц — 10 секунд.
  Ответы, пришедшие после дедлайна, не засчитываются.
- Участник комнаты может вернуться в неё в любой момент, включая середину игры
  (например, после перезагрузки страницы). Для тех, кого в комнате не было, вход в идущую игру закрыт.
- Если хост выходит, роль хоста переходит самому «старому» оставшемуся игроку.
  Когда уходят все — комната удаляется вместе с вопросами и ответами.
