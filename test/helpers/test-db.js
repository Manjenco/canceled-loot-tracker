/**
 * test-db.js — an in-memory D1 stand-in for the test suite.
 *
 * Wraps better-sqlite3 to expose the exact async surface db.js relies on:
 *   db.prepare(sql).bind(...).all()/.first()/.run()
 *   db.prepare(sql).all()/.first()/.run()        (unbound)
 *   db.batch([preparedStmts])                     (atomic transaction)
 *   db.exec(sql)
 *
 * Two fidelity details that make this catch real bugs rather than hide them:
 *   1. PRAGMA foreign_keys = ON — D1 enforces FK constraints by default;
 *      better-sqlite3 does NOT. Turning it on is what lets the migration test
 *      reproduce the FOREIGN KEY failures we hit in production.
 *   2. run() returns a D1-shaped meta object ({ last_row_id, changes }) rather
 *      than better-sqlite3's native ({ lastInsertRowid, changes }), so code like
 *      `result.meta.last_row_id` behaves identically to production.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..', '..');

/** Map a better-sqlite3 RunResult onto D1's meta shape. */
function toMeta(r) {
  const id = typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid;
  return {
    changes:           r.changes,
    last_row_id:       id,
    last_insert_rowid: id,
    rows_written:      r.changes,
  };
}

function wrap(sqlite) {
  // IMPORTANT: compile lazily. D1's prepare() does not validate against the
  // schema eagerly, so the migration runner can prepare a whole batch (e.g.
  // "CREATE INDEX ON t" alongside the "CREATE TABLE t" that precedes it) before
  // any of it runs. better-sqlite3 compiles at prepare() time and would reject
  // the index. Deferring compilation until run/all/first — by which point the
  // earlier statement in the batch transaction has executed — matches D1.
  const prepare = (sql) => {
    const isPragma = /^\s*PRAGMA\b/i.test(sql);
    let compiled = null;
    const stmt = () => (compiled ??= sqlite.prepare(sql));

    const doAll   = (args) => ({ results: stmt().all(...args), success: true, meta: {} });
    const doFirst = (args) => stmt().get(...args) ?? null;
    const doRun   = (args) => {
      // PRAGMAs carry no bind params; run verbatim via exec to be safe.
      if (isPragma) { sqlite.exec(sql); return { success: true, meta: toMeta({ changes: 0, lastInsertRowid: 0 }) }; }
      return { success: true, meta: toMeta(stmt().run(...args)) };
    };

    const make = (args) => ({
      sql,
      _args: args,
      _exec: () => doRun(args),          // used by batch(), evaluated inside the txn
      all:   () => Promise.resolve(doAll(args)),
      first: () => Promise.resolve(doFirst(args)),
      run:   () => Promise.resolve(doRun(args)),
    });

    return {
      ...make([]),
      bind: (...args) => make(args),
    };
  };

  // db.batch(statements) — statements are objects returned by prepare()/bind().
  // Runs them inside a single transaction, matching D1's atomic-batch semantics.
  //
  // Migrations that rebuild tables (DROP/RENAME) under PRAGMA defer_foreign_keys
  // trip better-sqlite3's deferred-violation counter: it mis-accounts across the
  // DDL and fails COMMIT even when the final state is referentially clean (which
  // is why the same SQL commits fine on D1). To match D1's outcome — commit iff
  // the data ends up valid — we follow SQLite's own recommended migration recipe:
  // disable FK enforcement around the batch, then verify integrity explicitly via
  // PRAGMA foreign_key_check before commit, throwing (→ rollback) if any real
  // orphan remains. This still surfaces genuine FK bugs in a migration's guards.
  const batch = (statements) => {
    const wasOn = sqlite.pragma('foreign_keys', { simple: true }) === 1;
    if (wasOn) sqlite.pragma('foreign_keys = OFF');
    try {
      const txn = sqlite.transaction((stmts) => {
        const out = stmts.map(s => s._exec());
        if (wasOn) {
          const violations = sqlite.prepare('PRAGMA foreign_key_check').all();
          if (violations.length) {
            const err = new Error('FOREIGN KEY constraint failed');
            err.violations = violations;
            throw err; // → better-sqlite3 rolls the transaction back
          }
        }
        return out;
      });
      return Promise.resolve(txn(statements));
    } finally {
      if (wasOn) sqlite.pragma('foreign_keys = ON');
    }
  };

  const exec = (sql) => { sqlite.exec(sql); return Promise.resolve(); };

  return { prepare, batch, exec, _sqlite: sqlite };
}

/** Create an in-memory DB with foreign keys enforced, optionally loading a schema. */
export function createDb(schemaSql) {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  if (schemaSql) sqlite.exec(schemaSql);
  return wrap(sqlite);
}

/** Fresh DB from the current production schema.sql (post-season-partitioning). */
export function createFreshDb() {
  return createDb(readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
}

/** DB from the pre-season-partitioning schema (the real old prod shape, from git). */
export function createPreSeasonDb() {
  return createDb(readFileSync(join(__dirname, '..', 'fixtures', 'schema-pre-season.sql'), 'utf8'));
}

/**
 * Run fn with FK enforcement temporarily disabled, so a test can construct a
 * deliberately "dirty" database (orphaned rows) that mirrors real prod data
 * which predates FK enforcement. fn receives the raw better-sqlite3 handle.
 */
export function withForeignKeysOff(db, fn) {
  db._sqlite.pragma('foreign_keys = OFF');
  try { fn(db._sqlite); }
  finally { db._sqlite.pragma('foreign_keys = ON'); }
}

/** Convenience: assert FK enforcement is actually on (sanity guard for tests). */
export function foreignKeysEnabled(db) {
  return db._sqlite.pragma('foreign_keys', { simple: true }) === 1;
}
