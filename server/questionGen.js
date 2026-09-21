// Server-side question generation. Keys live in server env, never in the browser,
// so every player in a room gets the exact same question set from one source of truth.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Keep this configurable, but use the fast model available to the deployed
// service by default. The larger model can spend long enough in tool loops for
// the hosting proxy to close the request and turn a healthy generation into a
// misleading 503 for players.
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

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

async function timeoutFetch(url, accept, ms = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { headers: { Accept: accept, 'User-Agent': 'Mozilla/5.0 (compatible; VihrBot/1.0)' }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function webSearch(query, maxResults = 4) {
  const clean = String(query || '').trim().slice(0, 240);
  if (!clean) return { ok: false, error: 'empty_query', results: [] };
  try {
    try {
      const direct = await timeoutFetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(clean)}`, 'text/html');
      if (direct.ok) {
        const results = parseDdgHtml(await direct.text(), maxResults);
        if (results.length) return { ok: true, results };
      }
    } catch { /* fall through to proxy */ }
    try {
      const proxied = await timeoutFetch(`https://r.jina.ai/http://duckduckgo.com/html/?q=${encodeURIComponent(clean)}`, 'text/plain');
      if (proxied.ok) {
        const results = parseJinaMarkdown(await proxied.text(), maxResults);
        if (results.length) return { ok: true, results };
      }
    } catch { /* fall through to instant answer */ }
    const instant = await timeoutFetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(clean)}&format=json&no_html=1&skip_disambig=1`, 'application/json');
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
    return { ok: false, error: String(e?.message || e), results: [] };
  }
}

async function webFetch(url, maxChars = 1600) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'invalid_url', text: '' };
  const read = async (candidate, accept) => {
    const res = await timeoutFetch(candidate, accept);
    if (!res.ok) throw new Error(`fetch_failed_${res.status}`);
    return { body: await res.text(), type: res.headers.get('content-type') || '' };
  };
  try {
    let payload;
    try { payload = await read(target, 'text/html,application/json'); }
    catch { payload = await read(`https://r.jina.ai/${target}`, 'text/plain'); }
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

async function runToolCall(call, onStep) {
  let args = {};
  try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* leave empty */ }
  if (call.function?.name === 'web_search') {
    const rawQuery = args.query || '';
    onStep?.({ type: 'web_search', query: maskSpoilerNumbers(rawQuery) });
    const result = await webSearch(rawQuery, 4); // the actual search still uses the real query
    onStep?.({ type: 'web_search_done', query: maskSpoilerNumbers(rawQuery), count: result.results?.length || 0, ok: result.ok });
    return result;
  }
  if (call.function?.name === 'web_fetch') {
    let host = args.url || '';
    try { host = new URL(args.url).hostname; } catch { /* keep raw */ }
    onStep?.({ type: 'web_fetch', host });
    const result = await webFetch(args.url || '');
    onStep?.({ type: 'web_fetch_done', host, ok: result.ok });
    return result;
  }
  return { ok: false, error: 'unknown_tool' };
}

async function callGroqWithKey(key, messages, jsonMode, useWebTools) {
  const body = {
    model: MODEL,
    messages,
    temperature: 0.9,
    // json_object and tools are mutually exclusive on a tool-enabled turn: forcing
    // strict JSON output would prevent the model from ever emitting a tool_call.
    // Only apply it once we're not also offering tools on this turn.
    ...(jsonMode && !useWebTools ? { response_format: { type: 'json_object' } } : {}),
    ...(useWebTools ? { tools: WEB_TOOL_SCHEMAS, tool_choice: 'auto' } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 28000);
  let res;
  try {
    res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Groq API: ${res.status} ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.choices[0].message;
}

// Runs a full tool-use loop against one key: the model may call web_search/web_fetch
// repeatedly before returning its final content. Capped so a stubborn model can't
// loop forever burning the internet budget on a single question batch.
async function callGroqWithToolsForKey(key, initialMessages, jsonMode, useWebTools, onStep, maxToolTurns = 1) {
  const messages = [...initialMessages];
  if (useWebTools) {
    for (let turn = 0; turn < maxToolTurns; turn++) {
      // Tool-bearing turns never force json_object (see callGroqWithKey) — that's
      // what lets the model actually emit tool_calls instead of being locked into JSON.
      const message = await callGroqWithKey(key, messages, jsonMode, true);
      if (!message.tool_calls || !message.tool_calls.length) {
        return message.content;
      }
      messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        const result = await runToolCall(call, onStep);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
  }
  // Either web tools are off, or the model kept calling tools past the cap —
  // close it out with one plain call that has no tools offered, so jsonMode
  // (if requested) can actually be enforced via response_format here.
  const final = await callGroqWithKey(key, messages, jsonMode, false);
  return final.content;
}

async function callGroq(messages, jsonMode, overrideKeys = '', useWebTools = false, onStep = null) {
  const keys = getKeys(overrideKeys);
  if (!keys.length) throw new Error('no_server_keys_configured');

  let lastErr = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      return await callGroqWithToolsForKey(keys[i], messages, jsonMode, useWebTools, onStep);
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

// Second pass: ask the model to fact-check its own batch of questions against the topic.
// This catches the case where generation invents plausible-sounding but nonexistent facts
// (e.g. a football player's transfer fee, a match score, a release date) rather than only
// checking the JSON shape. Returns the subset of questions judged factually sound.
async function factCheckQuestions(topic, language, questions, overrideKeys, onStep) {
  if (!questions.length) return [];

  const sys = `Ты строгий фактчекер для викторины на тему "${topic}". Тебе дают список вопросов с вариантами ответов и указанием правильного варианта.
Сегодня 2026 год — у тебя есть доступ к живому вебу через web_search и web_fetch. Используй их для КАЖДОГО вопроса, где ты не уверен на 100% в точности факта (даты, статистика, счёт, трансферы, рекорды, актуальные данные на 2026 год и т.п.): сделай один точный web_search, при необходимости открой лучшую страницу через web_fetch, и только потом выноси вердикт. Не угадывай и не полагайся только на память, если факт можно проверить.
Для КАЖДОГО вопроса проверь:
1. Правильный вариант действительно верен и соответствует реальным, проверяемым фактам — не выдуман ли он.
2. Вопрос однозначен и не содержит внутреннего противоречия.
3. Если тема касается спортивной статистики, счёта матчей, трансферов, рекордов, дат, версий игр/продуктов и подобных точных данных — будь особенно строг: если после поиска сомнение осталось, считай вопрос невалидным, а не угадывай.
Когда закончишь проверку и не планируешь больше вызывать инструменты, отвечай ТОЛЬКО JSON без пояснений и без markdown, в формате:
{"results": [{"index": 0, "valid": true}, {"index": 1, "valid": false, "reason": "краткая причина"}]}
index — позиция вопроса в списке (начиная с 0), по одному объекту на каждый вопрос из списка. Язык вопросов: ${language}.`;

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
      onStep
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
  // Bigger batches mean fewer generate→fact-check round trips for the same
  // total question count — each round trip is a full network call (plus any
  // web_search/web_fetch turns), so this is the safest lever for speed
  // without loosening what the fact-check pass accepts.
  const batchSize = 10;
  // Two short batches keep the request safely below the hosting timeout. Each
  // batch is still grounded with a live search when the model needs one.
  const maxAttempts = 2;
  let all = [];
  let provisional = [];
  const ageHint = AGE_PROMPT_HINTS[ageGroup] || AGE_PROMPT_HINTS.any;
  const exactFactsRule = exactFacts
    ? '\nРЕЖИМ ТОЧНЫХ ФАКТОВ: каждый вопрос должен опираться на конкретный проверяемый факт с числом — год, дату, количество, расстояние, длительность, счёт или рекорд. Для каждого такого факта сначала используй web_search, а при сомнении web_fetch. Не добавляй вопрос, если точное число нельзя подтвердить источником.'
    : '';

  for (let attempt = 0; attempt < maxAttempts && all.length < count; attempt++) {
    const remaining = Math.min(batchSize, count - all.length);
    // Ask for more than needed since fact-checking drops a chunk of every
    // batch — overshoot harder as attempts pile up so a stubborn topic
    // still converges instead of grinding through 10 near-empty rounds.
    const overshoot = attempt < 3 ? 2 : 4;
    const askFor = Math.min(batchSize, remaining + overshoot);

    onStep?.({ type: 'batch_start', attempt: attempt + 1, have: all.length, total: count });

    const sys = `Ты генератор вопросов для викторины. Сегодня 2026 год, и у тебя есть доступ к живому вебу через web_search и web_fetch — используй их, если тема требует актуальных на 2026 год фактов, точных цифр, дат, составов, версий или другой информации, в которой ты не уверен на 100% по памяти. Не изобретай факты, которые проще проверить одним поиском.
Когда закончишь (или если поиск не понадобился), отвечай ТОЛЬКО валидным JSON без пояснений, без markdown, в формате:
{"questions": [{"question": "текст вопроса", "options": ["вариант1","вариант2","вариант3","вариант4"], "correct": 0}]}
correct — индекс правильного варианта (0-3). Вопросы должны быть на языке: ${language}. Тема: ${topic}. Разнообразные, интересные, без повторов, средней сложности. ${ageHint}
КРИТИЧЕСКИ ВАЖНО: используй только реальные, проверяемые факты, при необходимости — сверенные через web_search/web_fetch. Если не уверен в точной цифре, дате, статистике или имени даже после проверки — не придумывай их и не включай такой вопрос. Не выдумывай данные, которых нет в реальности (несуществующие матчи, трансферы, рекорды, персонажей, игровые предметы и т.п. — если тема про конкретную игру, используй только то, что реально существует в этой игре).${exactFactsRule}`;

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
        true, // web tools on — lets it verify names/dates/stats for the topic before writing
        onStep
      );
    } catch (e) {
      // One bad call (rate limit blip, transient network) shouldn't fail the
      // whole room — try the next attempt instead of giving up immediately.
      onStep?.({ type: 'batch_done', have: Math.min(all.length, count), total: count });
      continue;
    }

    let parsed;
    try {
      parsed = extractJson(raw);
    } catch (e) {
      parsed = { questions: [] };
    }
    const shapeValid = (parsed.questions || []).filter(
      (q) => q.question && Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.correct) && q.correct < q.options.length
    );
    if (!shapeValid.length) {
      onStep?.({ type: 'batch_done', have: Math.min(all.length, count), total: count });
      continue;
    }

    // Preserve a valid generated batch before the optional second opinion. If
    // a checker or an upstream web provider is temporarily unavailable, the
    // game can still start instead of returning a 503 with no questions.
    const existing = new Set(provisional.map((q) => q.question.trim().toLowerCase()));
    provisional = provisional.concat(
      shapeValid.filter((q) => {
        const key = q.question.trim().toLowerCase();
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      })
    );

    const factChecked = await factCheckQuestions(topic, language, shapeValid, overrideKeys, onStep);
    all = all.concat(factChecked);
    onStep?.({ type: 'batch_done', have: Math.min(all.length, count), total: count });
  }

  // The generator has already been instructed to use live sources; this is a
  // graceful fallback only when the separate checker rejects or times out.
  if (all.length < count && provisional.length) {
    const existing = new Set(all.map((q) => q.question.trim().toLowerCase()));
    all = all.concat(provisional.filter((q) => !existing.has(q.question.trim().toLowerCase())));
    onStep?.({ type: 'batch_done', have: Math.min(all.length, count), total: count });
  }

  return all.slice(0, count);
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
