const express = require('express');
const { generateQuestions, generateTodPrompt, hasServerKeys } = require('../questionGen');
const { rateLimit } = require('../rateLimit');

const router = express.Router();

// Guests can play without an account or personal API key. The shared provider-key
// pool stays in the deployment environment, while this limit protects that pool
// from accidental loops and straightforward abuse.
const soloLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 6,
  message: 'Слишком много новых викторин. Попробуй ещё раз через несколько минут.',
});

function cleanText(value, fallback, maxLength) {
  const text = String(value || '').trim().slice(0, maxLength);
  return text || fallback;
}

function requestKey(value) {
  // A personal key is deliberately request-only: it is never written to the
  // database, session, logs, or returned to the browser.
  const key = String(value || '').trim();
  return key && key.length <= 300 ? key : '';
}

router.post('/questions', soloLimit, async (req, res, next) => {
  const body = req.body || {};
  const apiKey = requestKey(body.apiKey);
  if (!hasServerKeys() && !apiKey) {
    return res.status(503).json({ error: 'generator_unavailable', message: 'Генератор временно не настроен.' });
  }

  try {
    const topic = cleanText(body.topic, 'Общие знания', 80);
    const language = cleanText(body.language, 'Русский', 30);
    const ageGroup = ['kids', 'teen', 'adult', 'any'].includes(body.ageGroup) ? body.ageGroup : 'any';
    const count = Math.min(30, Math.max(3, parseInt(body.count, 10) || 8));
    const exactFacts = body.exactFacts !== false;
    const questions = await generateQuestions(topic, language, count, ageGroup, apiKey, exactFacts);

    if (!questions.length) {
      const message = apiKey
        ? 'Не удалось подготовить вопросы. Проверь ключ или попробуй другую тему.'
        : 'Не удалось подготовить точные факты по этой теме. Попробуй другую тему.';
      return res.status(503).json({ error: 'generator_unavailable', message });
    }
    res.json({ questions });
  } catch (err) {
    next(err);
  }
});

router.post('/truth-or-dare', soloLimit, async (req, res, next) => {
  const body = req.body || {};
  const apiKey = requestKey(body.apiKey);
  if (!hasServerKeys() && !apiKey) {
    return res.status(503).json({ error: 'generator_unavailable', message: 'Генератор временно не настроен.' });
  }

  try {
    const type = body.type === 'dare' ? 'dare' : 'truth';
    const language = cleanText(body.language, 'Русский', 30);
    const ageGroup = ['kids', 'teen', 'adult', 'any'].includes(body.ageGroup) ? body.ageGroup : 'any';
    const interest = cleanText(body.interest, '', 60);
    const text = await generateTodPrompt(type, language, ageGroup, interest, apiKey);
    res.json({ text });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
