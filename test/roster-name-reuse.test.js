/**
 * roster-name-reuse.test.js — soft-delete must not block reusing a character name.
 *
 * The roster name-uniqueness index is partial (WHERE deleted = 0): a soft-deleted
 * character keeps its real name but drops out of the index, so its (team_id,
 * char_name, server) can be reused by a new character. Covers both the fresh
 * schema and the 0012 migration that converts an existing full index.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFreshDb } from './helpers/test-db.js';
import { runMigrations } from '../src/lib/db.js';
import { MIGRATIONS } from '../src/lib/migrations.js';

async function addChar(db, teamId, name, server = '') {
  return (await db.prepare(
    "INSERT INTO roster (team_id, char_name, class, spec, role, server) VALUES (?, ?, 'Warrior', 'Arms', 'DPS', ?)"
  ).bind(teamId, name, server).run()).meta.last_row_id;
}

test('a soft-deleted character no longer blocks reusing its name', async (t) => {
  const db = createFreshDb();
  const teamId = (await db.prepare("INSERT INTO teams (name) VALUES ('T')").run()).meta.last_row_id;

  await t.test('reuse succeeds after soft-delete', async () => {
    const id = await addChar(db, teamId, 'Reuseme');
    await db.prepare('UPDATE roster SET deleted = 1 WHERE id = ?').bind(id).run();
    const id2 = await addChar(db, teamId, 'Reuseme'); // same name, fresh active row
    assert.ok(id2 && id2 !== id, 'a new character with the reused name was created');
  });

  await t.test('two live characters with the same name still conflict', async () => {
    await addChar(db, teamId, 'Dupe');
    await assert.rejects(() => addChar(db, teamId, 'Dupe'), /UNIQUE constraint/i);
  });
});

test('0012 migration converts a full index and unblocks name reuse', async (t) => {
  const db = createFreshDb();
  // Recreate the pre-migration state: swap the partial index for the old full one.
  await db.prepare('DROP INDEX idx_roster_name_server').run();
  await db.prepare('CREATE UNIQUE INDEX idx_roster_name_server ON roster(team_id, char_name, server)').run();

  const teamId = (await db.prepare("INSERT INTO teams (name) VALUES ('T')").run()).meta.last_row_id;
  const id = await addChar(db, teamId, 'Ghost');
  await db.prepare('UPDATE roster SET deleted = 1 WHERE id = ?').bind(id).run();

  // The old full index still blocks reuse — this is the reported bug.
  await assert.rejects(() => addChar(db, teamId, 'Ghost'), /UNIQUE constraint/i);

  // Running the migration set applies 0012 and fixes it.
  const results = await runMigrations(db, MIGRATIONS);
  const m = results.find(r => r.name === '0012_roster_soft_delete_unique');
  assert.ok(m && m.status !== 'error', `0012 did not apply cleanly: ${JSON.stringify(m)}`);

  const id2 = await addChar(db, teamId, 'Ghost');
  assert.ok(id2 && id2 !== id, 'name reuse works after the migration');
});
