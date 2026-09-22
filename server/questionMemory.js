const db = require('./db/init');

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[ё]/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function loadQuestionMemory(topic, language) {
  const topicKey = normalize(`${language}:${topic}`);
  if (!topicKey) return { topicKey, facts: [], questions: [] };
  const facts = db.prepare(
    'SELECT question, answer FROM verified_quiz_facts WHERE topic_key = ? ORDER BY id DESC LIMIT 30'
  ).all(topicKey).reverse();
  const questions = db.prepare(
    'SELECT question FROM quiz_question_history WHERE topic_key = ? ORDER BY id DESC LIMIT 80'
  ).all(topicKey).map((row) => row.question).reverse();
  return { topicKey, facts, questions };
}

function rememberVerifiedQuestions(topicKey, questions) {
  if (!topicKey || !questions.length) return;
  const addFact = db.prepare(
    'INSERT OR IGNORE INTO verified_quiz_facts (topic_key, question_key, question, answer) VALUES (?, ?, ?, ?)'
  );
  const addHistory = db.prepare(
    'INSERT OR IGNORE INTO quiz_question_history (topic_key, question_key, question) VALUES (?, ?, ?)'
  );
  const trimHistory = db.prepare(`
    DELETE FROM quiz_question_history
    WHERE topic_key = ? AND id NOT IN (
      SELECT id FROM quiz_question_history WHERE topic_key = ? ORDER BY id DESC LIMIT 500
    )
  `);
  const addAll = db.transaction((items) => {
    for (const item of items) {
      const question = String(item.question || '').trim().slice(0, 600);
      const answer = String(item.options?.[item.correct] || '').trim().slice(0, 300);
      const key = normalize(question);
      if (!key || !answer) continue;
      addFact.run(topicKey, key, question, answer);
      addHistory.run(topicKey, key, question);
    }
    trimHistory.run(topicKey, topicKey);
  });
  addAll(questions);
}

module.exports = { loadQuestionMemory, rememberVerifiedQuestions };
