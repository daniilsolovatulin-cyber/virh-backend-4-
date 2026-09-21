// Minimal in-memory rate limiter, no external dependency.
// Good enough for a single-process server; if this ever runs behind a load
// balancer with multiple instances, swap this for a shared store (Redis etc).

function rateLimit({ windowMs, max, message }) {
  const hits = new Map(); // key -> [timestamps]

  // periodic sweep so the map doesn't grow forever
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of hits) {
      const fresh = timestamps.filter((t) => t > cutoff);
      if (fresh.length) hits.set(key, fresh);
      else hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;
    const timestamps = (hits.get(key) || []).filter((t) => t > cutoff);

    if (timestamps.length >= max) {
      return res.status(429).json({ error: 'too_many_requests', message: message || 'Слишком много попыток. Подождите немного.' });
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    next();
  };
}

module.exports = { rateLimit };
