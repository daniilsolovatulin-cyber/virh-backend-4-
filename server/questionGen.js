// Server-side question generation. Keys live in server env, never in the browser,
// so every player in a room gets the exact same question set from one source of truth.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// The full reasoning model is used by default. It may be overridden only on
// the server, never by the browser or a player.
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GENERATION_TIMEOUT_MS = 50000;
const { loadQuestionMemory, rememberVerifiedQuestions } = require('./questionMemory');

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

function providerRetryDelayMs(headers, fallbackMs) {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(1000, dateMs - Date.now());
  }
  const reset = headers.get('x-ratelimit-reset-tokens') || '';
  const match = reset.match(/([\d.]+)\s*(ms|s|m)?/i);
  if (match) {
    const amount = Number(match[1]);
    const unit = (match[2] || 's').toLowerCase();
    if (Number.isFinite(amount)) return Math.max(1000, amount * (unit === 'm' ? 60000 : unit === 'ms' ? 1 : 1000));
  }
  return fallbackMs;
}

/* ---------------- Web access tools (real internet access for the model) ----------------
 * Same no-API-key approach as the client-side LiquidSheet assistant: DuckDuckGo's
 * HTML endpoint first, r.jina.ai as a CORS/anti-block proxy fallback, then DDG's
 * Instant Answer JSON as a last resort. Runs server-side under Node's native fetch,
 * so results are used to ground question generation in real, current facts instead
 * of the model's static training data. Never throws — a flaky network just means
 * the model falls back to its own knowledge for that call. */

function compactText(value, limit = 220) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function unwrapDdgHref(href) {
  const match = String(href || '').match(/[?&]uddg=([^&]+)/);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch { /* fall through */ }
  }
  return href || '';
}

function parseDdgHtml(html, maxResults) {
  const results = [];
  const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html)) && results.length < maxResults) {
    const url = unwrapDdgHref(m[1].replace(/&amp;/g, '&'));
    if (!/^https?:\/\//i.test(url)) continue;
    const title = compactText(m[2].replace(/<[^>]+>/g, ''), 120);
    const snippet = compactText(m[3].replace(/<[^>]+>/g, ''), 220);
    results.push({ title, url, snippet });
  }
  return results;
}

function parseJinaMarkdown(markdown, maxResults) {
  const results = [];
  const seen = new Set();
  const lines = String(markdown || '').split(/\r?\n/);
  for (let i = 0; i < lines.length && results.length < maxResults; i++) {
    const match = lines[i].match(/^\s*#{1,3}\s+\[(.+?)\]\((https?:\/\/[^)]+)\)/);
    if (!match) continue;
    const url = unwrapDdgHref(match[2]);
    if (!/^https?:\/\//i.test(url) || /duckduckgo\.com/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const snippetLine = lines.slice(i + 1, i + 7).find((line) => /^\s*\[[^!]/.test(line) && line.indexOf('](') > 55);
    const snippet = compactText(snippetLine ? snippetLine.replace(/^\s*\[|\]\(.*$/g, '') : '');
    results.push({ title: compactText(match[1], 120), url, snippet });
  }
  return results;
}

async function timeoutFetch(url, accept, ms = 3500, signal) {
  return fetch(url, {
    headers: { Accept: accept, 'User-Agent': 'Mozilla/5.0 (compatible; VihrBot/1.0)' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms),
  });
}

async function webSearch(query, maxResults = 4, signal) {
  const clean = String(query || '').trim().slice(0, 240);
  if (!clean) return { ok: false, error: 'empty_query', results: [] };
  try {
    try {
      const direct = await timeoutFetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(clean)}`, 'text/html', 3500, signal);
      if (direct.ok) {
        const results = parseDdgHtml(await direct.text(), maxResults);
        if (results.length) return { ok: true, results };
      }
    } catch { if (signal?.aborted) throw signal.reason; }
    try {
      const proxied = await timeoutFetch(`https://r.jina.ai/http://duckduckgo.com/html/?q=${encodeURIComponent(clean)}`, 'text/plain', 3500, signal);
      if (proxied.ok) {
        const results = parseJinaMarkdown(await proxied.text(), maxResults);
        if (results.length) return { ok: true, results };
      }
    } catch { if (signal?.aborted) throw signal.reason; }
    const instant = await timeoutFetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(clean)}&format=json&no_html=1&skip_disambig=1`, 'application/json', 3500, signal);
    if (instant.ok) {
      const data = await instant.json();
      const results = [];
      if (data.AbstractURL) results.push({ title: compactText(data.Heading || clean, 120), url: data.AbstractURL, snippet: compactText(data.AbstractText) });
      const topics = (data.RelatedTopics || []).flatMap((item) => item.Topics || [item]);
      for (const item of topics) {
        if (results.length >= maxResults) break;
        if (item.FirstURL) results.push({ title: compactText(item.Text, 120), url: item.FirstURL, snippet: compactText(item.Text) });
      }
      if (results.length) return { ok: true, results };
    }
    return { ok: false, error: 'no_results', results: [] };
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    return { ok: false, error: String(e?.message || e), results: [] };
  }
}

// Do the live lookup on the server, then give the compact results to the model
// as ordinary context. Groq's tool-call mode can stall on the free service;
// this keeps the same current-data grounding without making the player wait
// for a multi-turn tool conversation.
async function getSourceContext(topic, onStep, signal) {
  onStep?.({ type: 'web_search', query: maskSpoilerNumbers(topic) });
  const result = await webSearch(topic, 4, signal);
  onStep?.({ type: 'web_search_done', query: maskSpoilerNumbers(topic), count: result.results?.length || 0, ok: result.ok });
  if (!result.ok || !result.results?.length) return '';
  return result.results
    .map((item, index) => `Источник ${index + 1}: ${compactText(item.title, 120)} — ${compactText(item.snippet, 260)}`)
    .join('\n');
}

async function webFetch(url, maxChars = 1600, signal) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'invalid_url', text: '' };
  const read = async (candidate, accept) => {
    const res = await timeoutFetch(candidate, accept, 3500, signal);
    if (!res.ok) throw new Error(`fetch_failed_${res.status}`);
    return { body: await res.text(), type: res.headers.get('content-type') || '' };
  };
  try {
    let payload;
    try { payload = await read(target, 'text/html,application/json'); }
    catch { if (signal?.aborted) throw signal.reason; payload = await read(`https://r.jina.ai/${target}`, 'text/plain'); }
    let text = payload.body;
    if (!/json|text\/plain/i.test(payload.type)) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
    }
    text = compactText(text, maxChars);
    return text ? { ok: true, text } : { ok: false, error: 'empty_page', text: '' };
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    return { ok: false, error: String(e?.message || e), text: '' };
  }
}

const WEB_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the live web for current, real-world facts (2026 data, recent events, exact figures, names, dates). Returns a short list of {title, url, snippet}. IMPORTANT: this query is shown live to players waiting in the lobby before the game starts. Numbers and dates in it are auto-masked, but still phrase the query so it does not read as an obvious spoiler of the answer you are checking (e.g. prefer "исторический матч [команда А] [команда Б] счёт" over spelling out the exact score or year in the query text).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a specific URL (e.g. one returned by web_search) and return its readable plain-text content, for verifying a fact beyond the search snippet.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full URL to fetch, including https://' } },
        required: ['url'],
      },
    },
  },
];

// Search queries are shown live in the lobby while a game hasn't started yet —
// but the model often searches for the exact fact a question is about (a
// year, a score, a stat), which would spoil the answer before anyone even
// sees the question. Numbers and dates in the query get masked before they
// ever leave the server; this is a plain regex pass, not something the model
// can skip or get wrong.
function maskSpoilerNumbers(text) {
  return String(text || '')
    // dates: 1990, 12.05.2019, 5 мая 2021, May 5 2021, 2020-05-12, etc.
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, '▓▓▓▓')
    .replace(/\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/g, '▓▓▓▓')
    // any standalone number (years, scores, stats, counts, prices)
    .replace(/\b\d+([.,]\d+)?\b/g, (m) => '▓'.repeat(Math.min(m.length, 4)));
}

async function runToolCall(call, onStep, signal) {
  let args = {};
  try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* leave empty */ }
  if (call.function?.name === 'web_search') {
    const rawQuery = args.query || '';
    onStep?.({ type: 'web_search', query: maskSpoilerNumbers(rawQuery) });
    const result = await webSearch(rawQuery, 4, signal); // the actual search still uses the real query
    onStep?.({ type: 'web_search_done', query: maskSpoilerNumbers(rawQuery), count: result.results?.length || 0, ok: result.ok });
    return result;
  }
  if (call.function?.name === 'web_fetch') {
    let host = args.url || '';
    try { host = new URL(args.url).hostname; } catch { /* keep raw */ }
    onStep?.({ type: 'web_fetch', host });
    const result = await webFetch(args.url || '', 1600, signal);
    onStep?.({ type: 'web_fetch_done', host, ok: result.ok });
    return result;
  }
  return { ok: false, error: 'unknown_tool' };
}

async function callGroqWithKey(key, messages, jsonMode, useWebTools, model = MODEL, signal) {
  const body = {
    model,
    messages,
    temperature: 0.9,
    // json_object and tools are mutually exclusive on a tool-enabled turn: forcing
    // strict JSON output would prevent the model from ever emitting a tool_call.
    // Only apply it once we're not also offering tools on this turn.
    ...(jsonMode && !useWebTools ? { response_format: { type: 'json_object' } } : {}),
    ...(useWebTools ? { tools: WEB_TOOL_SCHEMAS, tool_choice: 'auto' } : {}),
  };
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(18000)]) : AbortSignal.timeout(18000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let providerError = {};
    try { providerError = JSON.parse(errText).error || {}; } catch { /* status is enough */ }
    const err = new Error(`Groq API: ${res.status}`);
    err.status = res.status;
    err.code = providerError.code || null;
    throw err;
  }
  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  if (!message || (!message.tool_calls?.length && !message.content?.trim())) {
    const err = new Error('empty_model_response');
    err.code = 'empty_model_response';
    throw err;
  }
  return message;
}

// Bound provider calls and tool turns. A 429 can last until the next daily
// reset, so waiting for Retry-After here would strand a whole lobby.
async function callGroq(messages, jsonMode, overrideKeys = '', useWebTools = false, onStep = null, signal) {
  const keys = getKeys(overrideKeys);
  if (!keys.length) throw new Error('no_server_keys_configured');
  let lastErr;
  for (const key of keys) {
    try {
      const first = await callGroqWithKey(key, messages, jsonMode, useWebTools, MODEL, signal);
      if (!useWebTools || !first.tool_calls?.length) return first.content;
      const evidence = [];
      for (const call of first.tool_calls) {
        const result = await runToolCall(call, onStep, signal);
        evidence.push(`${call.function?.name || 'web'}: ${JSON.stringify(result)}`);
      }
      const finalMessages = [...messages, {
        role: 'system',
        content: `Поиск завершён. Не вызывай инструменты. Используй найденные источники и ответь строго JSON.\n${evidence.join('\n').slice(0, 14000)}`,
      }];
      const final = await callGroqWithKey(key, finalMessages, jsonMode, false, MODEL, signal);
      return final.content;
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      lastErr = err;
      if (MODEL === 'openai/gpt-oss-120b' && (err.status === 429 || (err.status === 400 && err.code === 'tool_use_failed') || err.code === 'empty_model_response')) {
        try {
          const fallbackMessages = [...messages, { role: 'system', content: 'Инструменты недоступны. Используй только уже переданные источники и ответь строго JSON.' }];
          const fallback = await callGroqWithKey(key, fallbackMessages, jsonMode, false, 'openai/gpt-oss-20b', signal);
          return fallback.content;
        } catch (fallbackError) {
          if (signal?.aborted) throw signal.reason;
          lastErr = fallbackError;
        }
      }
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

// Second pass: ask the model to fact-check its own batch of questions against the topic.
// This catches the case where generation invents plausible-sounding but nonexistent facts
// (e.g. a football player's transfer fee, a match score, a release date) rather than only
// checking the JSON shape. Returns the subset of questions judged factually sound.
async function factCheckQuestions(topic, language, questions, overrideKeys, onStep, knownFacts = [], cacheMinimum = 5, sourceContext = '', signal) {
  if (!questions.length) return [];

  const cachedFacts = knownFacts.map((item) => `- ${item.question} Правильный ответ: ${item.answer}`).join('\n');
  const canUseCacheOnly = knownFacts.length >= cacheMinimum;
  const sys = `Ты строгий фактчекер для викторины на тему "${topic}". Тебе дают список вопросов с вариантами ответов и указанием правильного варианта.
${canUseCacheOnly
    ? `Постоянная память содержит ранее проверенные факты. Сверяй новые вопросы именно с ней, принимай только вопросы, однозначно следующие из этих фактов. Не вызывай веб-инструменты и не добавляй неподтверждённые сведения.\n${cachedFacts}`
    : 'Сегодня 2026 год. Сверяй вопросы с предоставленными сервером выдержками источников. Если для точного факта (даты, счёта, рекорда, статистики) подтверждения недостаточно, пометь вопрос невалидным. Не вызывай веб-инструменты и не угадывай.'}
Для КАЖДОГО вопроса проверь:
1. Правильный вариант действительно верен и соответствует реальным, проверяемым фактам — не выдуман ли он.
2. Вопрос однозначен и не содержит внутреннего противоречия.
3. Если тема касается спортивной статистики, счёта матчей, трансферов, рекордов, дат, версий игр/продуктов и подобных точных данных — будь особенно строг: если после поиска сомнение осталось, считай вопрос невалидным, а не угадывай.
Когда закончишь проверку и не планируешь больше вызывать инструменты, отвечай ТОЛЬКО JSON без пояснений и без markdown, в формате:
{"results": [{"index": 0, "valid": true}, {"index": 1, "valid": false, "reason": "краткая причина"}]}
index — позиция вопроса в списке (начиная с 0), по одному объекту на каждый вопрос из списка. Язык вопросов: ${language}.
${sourceContext ? `Серверные выдержки источников для проверки:\n${sourceContext}` : ''}`;

  const userMsg = JSON.stringify(
    questions.map((q, i) => ({ index: i, question: q.question, options: q.options, correctAnswer: q.options[q.correct] }))
  );

  let raw;
  try {
    onStep?.({ type: 'fact_check_start', count: questions.length });
    raw = await callGroq(
      [
        { role: 'system', content: sys },
        { role: 'user', content: userMsg },
      ],
      true,
      overrideKeys,
      false,
      onStep,
      signal
    );
  } catch (e) {
    // Fact-check call itself failed (rate limit, network, etc). Fail safe by keeping
    // nothing rather than risking unverified content reaching players.
    return [];
  }

  let parsed;
  try {
    parsed = extractJson(raw);
  } catch (e) {
    return [];
  }

  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const validIndices = new Set(
    results.filter((r) => r && r.valid === true && Number.isInteger(r.index)).map((r) => r.index)
  );
  const kept = questions.filter((_, i) => validIndices.has(i));
  onStep?.({ type: 'fact_check_done', kept: kept.length, total: questions.length });
  return kept;
}

async function generateQuestions(topic, language, count, ageGroup, overrideKeys = '', onStep = null, exactFacts = false) {
  // Larger batches reduce API calls, while the lobby percent tracks only unique
  // questions actually accepted from the model.
  const batchSize = 10;
  // Limit both the number of attempts and total time. An exhausted provider
  // quota or an overly strict fact check must not trap a room in generation.
  const maxAttempts = Math.max(2, Math.ceil(count / batchSize) + 1);
  const signal = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
  let all = [];
  const correctPositionCounts = [0, 0, 0, 0];
  const ageHint = AGE_PROMPT_HINTS[ageGroup] || AGE_PROMPT_HINTS.any;
  const memory = loadQuestionMemory(topic, language);
  const useMemoryOnly = memory.facts.length >= Math.min(5, count);
  const sourceContext = useMemoryOnly ? '' : await getSourceContext(topic, onStep, signal);
  const memoryContext = memory.facts
    .map((item, index) => `Проверенный факт ${index + 1}: ${item.question} Правильный ответ: ${item.answer}`)
    .join('\n');
  const recentQuestions = memory.questions.slice(-60);
  const exactFactsRule = exactFacts
    ? '\nРЕЖИМ ТОЧНЫХ ФАКТОВ: если в вопросе есть год, дата, количество, счёт или рекорд, подтверждай число источником. Не заставляй каждый вопрос содержать число: выбирай естественные для темы факты, события и понятия. Никогда не спрашивай, какой год или слово «упоминается в найденных материалах». Если факт не подтверждается, замени вопрос другим по той же теме.'
    : '';

  for (let attempt = 0; attempt < maxAttempts && all.length < count && !signal.aborted; attempt++) {
    const remaining = Math.min(batchSize, count - all.length);
    // Ask for more than needed since fact-checking drops a chunk of every
    // batch — overshoot harder as attempts pile up so a stubborn topic
    // still converges instead of grinding through 10 near-empty rounds.
    const overshoot = attempt < 3 ? 2 : 4;
    const askFor = Math.min(batchSize, remaining + overshoot);

    onStep?.({ type: 'batch_start', attempt: attempt + 1, have: all.length, total: count });

    const sys = `Ты генератор вопросов для викторины. ${useMemoryOnly
      ? `Сервер передал тебе постоянную память — ранее проверенные факты по этой теме. Используй ТОЛЬКО эти факты; веб-поиск сейчас не нужен. Придумывай новые вопросы и другие углы проверки знания, не меняя смысл фактов и не повторяя сохранённые формулировки.\n${memoryContext}`
      : 'Сервер выполнил поиск по теме и передал найденные выдержки ниже. Используй их для свежих сведений; веб-инструменты в этой попытке недоступны. Если данных недостаточно, не выдумывай.'}
Когда закончишь (или если поиск не понадобился), отвечай ТОЛЬКО валидным JSON без пояснений, без markdown, в формате:
{"questions": [{"question": "текст вопроса", "options": ["вариант1","вариант2","вариант3","вариант4"], "correct": 0}]}
correct — индекс правильного варианта (0-3). Вопросы должны быть на языке: ${language}. Тема: ${topic}. Разнообразные, интересные, без повторов, средней сложности. ${ageHint}
    КРИТИЧЕСКИ ВАЖНО: используй только реальные, проверяемые факты. Если не уверен в точной цифре, дате, статистике или имени — не придумывай их и не включай такой вопрос. Не выдумывай данные, которых нет в реальности (несуществующие матчи, трансферы, рекорды, персонажей, игровые предметы и т.п. — если тема про конкретную игру, используй только то, что реально существует в этой игре).${exactFactsRule}
${recentQuestions.length ? `\nВопросы, которые уже задавались по этой теме. Не повторяй их и не делай лишь поверхностную переформулировку:\n${recentQuestions.map((q) => `- ${q}`).join('\n')}` : ''}
${sourceContext ? `\nСвежие выдержки серверного поиска — используй их как приоритетный источник, но не копируй ссылки в вопросы:\n${sourceContext}` : ''}`;

    const userMsg = `Сгенерируй ${askFor} новых вопросов по теме "${topic}" на языке ${language}. Не повторяй уже использованные формулировки: ${all
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
        overrideKeys,
        false,
        onStep,
        signal
      );
    } catch (e) {
      console.error('[question-generation] upstream request failed', {
        status: e?.status || null,
        code: e?.code || (signal.aborted ? 'generation_timeout' : 'upstream_error'),
      });
      throw e;
    }

    let parsed;
    try {
      parsed = extractJson(raw);
    } catch (e) {
      parsed = { questions: [] };
    }
    const shapeValid = (Array.isArray(parsed.questions) ? parsed.questions : []).filter(
      (q) => q && typeof q.question === 'string' && q.question.trim() &&
        Array.isArray(q.options) && q.options.length === 4 &&
        q.options.every((option) => typeof option === 'string' && option.trim()) &&
        Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length
    );
    if (!shapeValid.length) {
      onStep?.({ type: 'batch_done', have: Math.min(all.length, count), total: count });
      continue;
    }

    const factChecked = await factCheckQuestions(topic, language, shapeValid, overrideKeys, onStep, memory.facts, Math.min(5, count), sourceContext, signal);
    if (!factChecked.length) {
      onStep?.({ type: 'batch_done', have: Math.min(all.length, count), total: count });
      continue;
    }

    const normalizeQuestion = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[ё]/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
    const existing = new Set([...memory.questions, ...all.map((q) => q.question)].map(normalizeQuestion));
    const uniqueQuestions = factChecked.filter((q) => {
      const key = normalizeQuestion(q.question);
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    });

    // Models tend to put their answer first. Shuffle the distractors and place
    // the correct answer in the least-used valid slot so each game has a
    // balanced answer-key distribution without changing the correct answer.
    const balancedQuestions = uniqueQuestions.map((q) => {
      const slotCount = Math.min(q.options.length, correctPositionCounts.length);
      const lowestCount = Math.min(...correctPositionCounts.slice(0, slotCount));
      const leastUsedSlots = correctPositionCounts
        .slice(0, slotCount)
        .map((value, index) => value === lowestCount ? index : -1)
        .filter((index) => index >= 0);
      const correct = leastUsedSlots[Math.floor(Math.random() * leastUsedSlots.length)];
      const correctAnswer = q.options[q.correct];
      const distractors = q.options.filter((_, index) => index !== q.correct);
      for (let i = distractors.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [distractors[i], distractors[j]] = [distractors[j], distractors[i]];
      }
      distractors.splice(correct, 0, correctAnswer);
      correctPositionCounts[correct]++;
      return { ...q, options: distractors, correct };
    });

    all = all.concat(balancedQuestions);
    onStep?.({ type: 'batch_done', have: Math.min(all.length, count), total: count });
  }

  if (!all.length && signal.aborted) throw signal.reason;
  const result = all.slice(0, count);
  try {
    rememberVerifiedQuestions(memory.topicKey, result);
  } catch (error) {
    console.error('[question-memory] failed to save verified facts', String(error?.message || error).slice(0, 240));
  }
  return result;
}

async function generateTodPrompt(type, language, ageGroup, interest, overrideKeys = '') {
  const ageHint = AGE_PROMPT_HINTS[ageGroup] || AGE_PROMPT_HINTS.any;
  const interestHint = interest ? ` Учитывай интерес участников: ${interest}.` : '';
  const prompt = `Ты генератор для игры «Правда или действие». Отвечай только валидным JSON без markdown: {"text":"..."}. Язык: ${language}. ${type === 'dare' ? 'Придумай весёлое, безопасное и лёгкое в исполнении действие.' : 'Придумай интересный, немного дерзкий, но безобидный вопрос для правды.'} Не повторяйся. ${ageHint}${interestHint}`;
  const raw = await callGroq(
    [{ role: 'system', content: prompt }, { role: 'user', content: type === 'dare' ? 'Задание для действия' : 'Вопрос для правды' }],
    true,
    overrideKeys
  );
  const text = extractJson(raw)?.text;
  if (!text || typeof text !== 'string') throw new Error('invalid_tod_response');
  return text.trim().slice(0, 500);
}

module.exports = { generateQuestions, generateTodPrompt, hasServerKeys: () => getKeys().length > 0 };
