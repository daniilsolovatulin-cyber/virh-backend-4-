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

router.post('/questions', soloLimit, async (req, res, next) => {
  if (!hasServerKeys()) {
    return res.status(503).json({ error: 'generator_unavailable', message: 'Генератор временно не настроен.' });
  }

  try {
    const body = req.body || {};
    const topic = cleanText(body.topic, 'Общие знания', 80);
    const language = cleanText(body.language, 'Русский', 30);
    const ageGroup = ['kids', 'teen', 'adult', 'any'].includes(body.ageGroup) ? body.ageGroup : 'any';
    const count = Math.min(30, Math.max(3, parseInt(body.count, 10) || 8));
    const questions = await generateQuestions(topic, language, count, ageGroup);

    if (!questions.length) {
      return res.status(503).json({ error: 'generator_unavailable', message: 'Не удалось подготовить вопросы. Попробуй ещё раз.' });
    }
    res.json({ questions });
  } catch (err) {
    next(err);
  }
});

router.post('/truth-or-dare', soloLimit, async (req, res, next) => {
  if (!hasServerKeys()) {
    return res.status(503).json({ error: 'generator_unavailable', message: 'Генератор временно не настроен.' });
  }

  try {
    const body = req.body || {};
    const type = body.type === 'dare' ? 'dare' : 'truth';
    const language = cleanText(body.language, 'Русский', 30);
    const ageGroup = ['kids', 'teen', 'adult', 'any'].includes(body.ageGroup) ? body.ageGroup : 'any';
    const interest = cleanText(body.interest, '', 60);
    const text = await generateTodPrompt(type, language, ageGroup, interest);
    res.json({ text });
  } catch (err) {
    next(err);
  }
});

module.exports = { router };
