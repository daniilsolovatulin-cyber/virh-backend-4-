const express = require('express');
const { generateQuestions, generateTodPrompt, hasServerKeys } = require('../questionGen');
const { rateLimit } = require('../rateLimit');

const router = express.Router();

// Guests can play without an account. This protects the shared server key
// from accidental loops while still allowing a personal one-off key.
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
  // Deliberately request-only: never written to DB, session, logs, or response.
  const key = String(value || '').trim();
  return key.length <= 300 ? key : '';
}

function ageGroup(value) {
  return ({ teen: 'teens', adult: 'adults' })[value] || (['kids', 'teens', 'adults', 'any'].includes(value) ? value : 'any');
}

function generatorReady(personalKey) {
  return hasServerKeys() || !!personalKey;
}

router.post('/questions', soloLimit, async (req, res, next) => {
  const body = req.body || {};
  const apiKey = requestKey(body.apiKey);
  if (!generatorReady(apiKey)) {
    return res.status(503).json({ error: 'generator_unavailable', message: 'Генератор временно не настроен.' });
  }
  try {
    const questions = await generateQuestions(
      cleanText(body.topic, 'Общие знания', 80),
      cleanText(body.language, 'Русский', 30),
      Math.min(30, Math.max(3, parseInt(body.count, 10) || 8)),
      ageGroup(body.ageGroup),
      apiKey,
      null,
      body.exactFacts !== false
    );
    if (!questions.length) {
      return res.status(503).json({ error: 'generator_unavailable', message: 'Не удалось подготовить проверенные вопросы. Попробуй другую тему.' });
    }
    res.json({ questions });
  } catch (err) {
    next(err);
  }
});

router.post('/truth-or-dare', soloLimit, async (req, res, next) => {
  const body = req.body || {};
  const apiKey = requestKey(body.apiKey);
  if (!generatorReady(apiKey)) {
    return res.status(503).json({ error: 'generator_unavailable', message: 'Генератор временно не настроен.' });
  }
  try {
    const text = await generateTodPrompt(
      body.type === 'dare' ? 'dare' : 'truth',
      cleanText(body.language, 'Русский', 30),
      ageGroup(body.ageGroup),
      cleanText(body.interest, '', 60),
      apiKey
    );
    res.json({ text });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
