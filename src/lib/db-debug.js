/**
 * db-debug.js — In-process DB read statistics accumulator.
 *
 * Accumulates within a single Worker isolate's lifetime. Stats survive across
 * requests while the isolate is alive (typically minutes during active use).
 *
 * Only populated when process.env.DB_DEBUG is set. Tracking calls in db.js
 * are guarded by `if (process.env.DB_DEBUG)` so this module stays inert when
 * the flag is absent — nothing is written to the stats object.
 */

const _stats = {
  resetAt:       Date.now(),
  cacheHits:     0,
  cacheMisses:   0,
  totalRowsRead: 0,
  tables:        {},   // key → { hits, misses, rows }
};

export function trackCacheHit(key) {
  _stats.cacheHits++;
  const t = _stats.tables[key] ??= { hits: 0, misses: 0, rows: 0 };
  t.hits++;
}

export function trackCacheMiss(key, rowCount) {
  _stats.cacheMisses++;
  _stats.totalRowsRead += rowCount;
  const t = _stats.tables[key] ??= { hits: 0, misses: 0, rows: 0 };
  t.misses++;
  t.rows += rowCount;
}

export function getStats() {
  return {
    resetAt:       _stats.resetAt,
    cacheHits:     _stats.cacheHits,
    cacheMisses:   _stats.cacheMisses,
    totalRowsRead: _stats.totalRowsRead,
    tables:        Object.fromEntries(
      Object.entries(_stats.tables).sort((a, b) => b[1].rows - a[1].rows)
    ),
  };
}

export function resetStats() {
  _stats.resetAt       = Date.now();
  _stats.cacheHits     = 0;
  _stats.cacheMisses   = 0;
  _stats.totalRowsRead = 0;
  _stats.tables        = {};
}
