// Server-side question generation. Keys live in server env, never in the browser,
// so every player in a room gets the exact same question set from one source of truth.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'openai/gpt-oss-20b';
// Without a timeout a hung request leaves the whole room stuck in "generating" forever.
const REQUEST_TIMEOUT_MS = 30000;

function getKeys(overrideKeys = '') {
  return (overrideKeys || process.env.GROQ_API_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

const AGE_PROMPT_HINTS = {
  kids: 'Аудитория: дети. Никакой жестокости, пошлости, сложных терминов.',
  teens: 'Аудитория: подростки. Дружелюбный тон, без взрослого контента.',
  adults: 'Аудитория: взрослые. Можно сложнее и с юмором для взрослых, но без пошлости.',
  any: 'Аудитория: смешанная, держись нейтрального дружелюбного тона.',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callGroqWithKey(key, messages, jsonMode) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.9,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Groq API: ${res.status} ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Groq API: пустой ответ модели');
  }
  return content;
}

async function callGroq(messages, jsonMode, overrideKeys = '') {
  const keys = getKeys(overrideKeys);
  if (!keys.length) throw new Error('no_server_keys_configured');

  let lastErr = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      return await callGroqWithKey(keys[i], messages, jsonMode);
    } catch (err) {
      lastErr = err;
      if (err.status === 429 || err.status === 401 || err.status === 403) continue;
      await sleep(400);
    }
  }
  throw lastErr || new Error('all_keys_failed');
}

function extractJson(raw) {
  let cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const startArr = cleaned.indexOf('[');
  let s = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
  if (s > 0) cleaned = cleaned.slice(s);
  return JSON.parse(cleaned);
}

async function generateQuestions(topic, language, count, ageGroup, overrideKeys = '') {
  const batchSize = 4;
  const batches = Math.ceil(count / batchSize);
  let all = [];
  const ageHint = AGE_PROMPT_HINTS[ageGroup] || AGE_PROMPT_HINTS.any;

  for (let b = 0; b < batches; b++) {
    const remaining = Math.min(batchSize, count - all.length);
    if (remaining <= 0) break;

    const sys = `Ты генератор вопросов для викторины. Отвечай ТОЛЬКО валидным JSON без пояснений, без markdown, в формате:
{"questions": [{"question": "текст вопроса", "options": ["вариант1","вариант2","вариант3","вариант4"], "correct": 0}]}
correct — индекс правильного варианта (0-3). Вопросы должны быть на языке: ${language}. Тема: ${topic}. Разнообразные, интересные, без повторов, средней сложности. ${ageHint}`;

    const userMsg = `Сгенерируй ${remaining} новых вопросов по теме "${topic}" на языке ${language}. Не повторяй уже использованные формулировки: ${all
      .map((q) => q.question)
      .join(' | ')
      .slice(0, 800)}`;

    let raw;
    try {
      raw = await callGroq(
        [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg },
        ],
        true,
        overrideKeys
      );
    } catch (e) {
      break;
    }

    let parsed;
    try {
      parsed = extractJson(raw);
    } catch (e) {
      parsed = { questions: [] };
    }
    // A question whose "correct" index is missing or out of range can never be answered
    // correctly, so drop it instead of shipping an unwinnable round to the players.
    const qs = (parsed.questions || [])
      .filter(
        (q) =>
          q &&
          typeof q.question === 'string' &&
          q.question.trim() &&
          Array.isArray(q.options) &&
          q.options.length >= 2 &&
          q.options.every((o) => typeof o === 'string' && o.trim()) &&
          Number.isInteger(q.correct) &&
          q.correct >= 0 &&
          q.correct < q.options.length
      )
      .map((q) => ({
        question: q.question.trim(),
        options: q.options.map((o) => o.trim()),
        correct: q.correct,
      }));
    all = all.concat(qs);
  }

  return all.slice(0, count);
}

async function generateTodPrompt(type, language, ageGroup, interest) {
  const ageHint = AGE_PROMPT_HINTS[ageGroup] || AGE_PROMPT_HINTS.any;
  const interestHint = interest ? ` Учитывай интерес участников: ${interest}.` : '';
  const task = type === 'dare'
    ? 'Придумай весёлое, лёгкое в исполнении действие или задание.'
    : 'Придумай интересный, немного дерзкий, но безобидный вопрос для правды.';
  const raw = await callGroq([
    { role: 'system', content: `Ты генератор для игры «Правда или действие». Отвечай ТОЛЬКО валидным JSON в формате {"text":"..."}. Язык: ${language}. ${task} ${ageHint}${interestHint}` },
    { role: 'user', content: type === 'dare' ? 'Новое действие' : 'Новый вопрос для правды' },
  ], true);
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed.text !== 'string' || !parsed.text.trim()) throw new Error('invalid_tod_response');
  return parsed.text.trim();
}

module.exports = { generateQuestions, generateTodPrompt, hasServerKeys: () => getKeys().length > 0 };
