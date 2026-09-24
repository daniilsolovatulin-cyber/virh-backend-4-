const test = require('node:test');
const assert = require('node:assert/strict');

const memoryPath = require.resolve('./questionMemory');
require.cache[memoryPath] = {
  id: memoryPath,
  filename: memoryPath,
  loaded: true,
  exports: {
    loadQuestionMemory: () => ({ topicKey: 'test', facts: [], questions: [] }),
    rememberVerifiedQuestions: () => {},
  },
};
const { generateQuestions } = require('./questionGen');

const questions = [
  { question: 'Столица Франции?', options: ['Париж', 'Лион', 'Марсель', 'Ницца'], correct: 0 },
  { question: 'Сколько сторон у треугольника?', options: ['Три', 'Две', 'Четыре', 'Пять'], correct: 0 },
  { question: 'Как называется спутник Земли?', options: ['Луна', 'Марс', 'Венера', 'Солнце'], correct: 0 },
];

function response(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('429 on 120b switches to 20b, fact-checks, and finishes', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    if (!String(url).includes('api.groq.com')) return response(200, {});
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.model === 'openai/gpt-oss-120b') return response(429, { error: { code: 'rate_limit_exceeded' } });
    const check = body.messages[0].content.includes('фактчекер');
    const content = check
      ? JSON.stringify({ results: questions.map((_, index) => ({ index, valid: true })) })
      : JSON.stringify({ questions });
    return response(200, { choices: [{ message: { content } }] });
  };
  try {
    const result = await generateQuestions('Общие знания', 'Русский', 3, 'any', 'test-key');
    assert.equal(result.length, 3);
    assert.deepEqual(calls.map((call) => call.model), [
      'openai/gpt-oss-120b', 'openai/gpt-oss-20b',
      'openai/gpt-oss-120b', 'openai/gpt-oss-20b',
    ]);
    assert.ok(calls.every((call) => !call.tools));
  } finally {
    global.fetch = originalFetch;
  }
});

test('provider outage rejects promptly instead of looping or inventing questions', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('api.groq.com')) {
      calls++;
      return response(429, { error: { code: 'rate_limit_exceeded' } });
    }
    return response(200, {});
  };
  try {
    await assert.rejects(generateQuestions('История', 'Русский', 3, 'any', 'test-key'), (error) => error.status === 429);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
