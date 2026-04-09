/**
 * apply-local-migration.js
 *
 * Applies migration-output.sql directly to the local wrangler D1 SQLite file,
 * bypassing `wrangler d1 execute` which stalls on large files.
 *
 * Usage:
 *   node scripts/apply-local-migration.js
 *
 * Stop `wrangler dev` before running this.
 */

import Database    from 'better-sqlite3';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve }  from 'path';

const D1_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const SQL_FILE = 'migration-output.sql';

// Pick the most recently modified .sqlite file (the one wrangler dev uses)
const files = readdirSync(D1_DIR)
  .filter(f => f.endsWith('.sqlite') && !f.endsWith('-shm') && !f.endsWith('-wal'))
  .map(f => ({ name: f, mtime: statSync(`${D1_DIR}/${f}`).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (!files.length) {
  console.error(`No SQLite file found in ${D1_DIR}. Start wrangler dev once first to create it.`);
  process.exit(1);
}

const dbPath  = resolve(`${D1_DIR}/${files[0].name}`);
const sqlPath = resolve(SQL_FILE);

console.log(`Database: ${dbPath}`);
console.log(`SQL file: ${sqlPath}`);

const sql = readFileSync(sqlPath, 'utf8');
const db  = new Database(dbPath);

console.log('Applying migration…');
try {
  db.exec(sql);
  console.log('Done.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  db.close();
}
