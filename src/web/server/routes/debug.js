/**
 * debug.js — DB read statistics endpoint.
 *
 * Only active when DB_DEBUG env var is set. Returns 404 otherwise so the
 * frontend panel stays completely hidden in production.
 *
 * GET  /api/debug/db-stats  — return current stats
 * POST /api/debug/db-stats/reset — reset stats, return fresh snapshot
 */

import { Hono } from 'hono';
import { getStats, resetStats } from '../../../lib/db-debug.js';

const router = new Hono();

router.get('/db-stats', (c) => {
  if (!process.env.DB_DEBUG) return c.json({ error: 'Not found' }, 404);
  return c.json(getStats());
});

router.post('/db-stats/reset', (c) => {
  if (!process.env.DB_DEBUG) return c.json({ error: 'Not found' }, 404);
  resetStats();
  return c.json(getStats());
});

export default router;
