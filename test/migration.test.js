/**
 * migration.test.js — regression guard for the 0005_seasons migration.
 *
 * Reproduces the exact production scenario that failed three times: a pre-season
 * database carrying "dirty" rows (orphaned foreign keys, stale item ids) that
 * predate D1's FK enforcement. The migration must survive it — dropping or
 * nulling the orphans via its guards — rather than aborting with a constraint
 * error.
 *
 * Sequence mirrors real prod:
 *   1. start from the pre-season schema (extracted from git)
 *   2. apply migrations 0001–0004 (creates loot_summary, soft-delete, etc.)
 *   3. seed valid data + deliberately orphaned rows (FK enforcement off)
 *   4. apply the full migration set — 0005 runs against the dirty DB
 *   5. assert it succeeded and the data landed correctly in season 1
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPreSeasonDb, withForeignKeysOff } from './helpers/test-db.js';
import { runMigrations } from '../src/lib/db.js';
import { MIGRATIONS } from '../src/lib/migrations.js';

const NO_SUCH_ROSTER_ID = 99990;
const NO_SUCH_RAID_ID   = 99991;
const NO_SUCH_ITEM_ID   = 99992;

test('0005_seasons migrates a dirty pre-season database cleanly', async (t) => {
  const D = createPreSeasonDb();

  // ── 2. apply 0001–0004 (everything before seasons) ───────────────────────────
  const pre = await runMigrations(D, MIGRATIONS.slice(0, 4));
  assert.ok(pre.every(r => r.status !== 'error'), `pre-migrations failed: ${JSON.stringify(pre)}`);

  // ── 3. seed valid baseline ───────────────────────────────────────────────────
  const teamId = (await D.prepare("INSERT INTO teams (name) VALUES ('T')").run()).meta.last_row_id;

  const c1 = (await D.prepare(
    "INSERT INTO roster (team_id, char_name, class, spec, role) VALUES (?, 'C1', 'Warrior', 'Arms', 'DPS')"
  ).bind(teamId).run()).meta.last_row_id;
  const c2 = (await D.prepare(
    "INSERT INTO roster (team_id, char_name, class, spec, role) VALUES (?, 'C2', 'Mage', 'Frost Mage', 'DPS')"
  ).bind(teamId).run()).meta.last_row_id;

  const raidPk = (await D.prepare(
    "INSERT INTO raids (raid_id, team_id, date, instance, difficulty) VALUES ('RPT', ?, '2026-01-01', 'Inst', 'Mythic')"
  ).bind(teamId).run()).meta.last_row_id;

  const itemPk = (await D.prepare(
    "INSERT INTO item_db (item_id, name, slot, source_type, source_name, instance, difficulty, armor_type) " +
    "VALUES ('500', 'Helm', 'Head', 'Raid', 'Boss', 'Inst', 'Mythic', 'Plate')"
  ).run()).meta.last_row_id;

  await D.prepare(
    "INSERT INTO loot_log (team_id, date, boss, item_name, difficulty, recipient_char_id, upgrade_type) " +
    "VALUES (?, '2026-01-02', 'Boss', 'Helm', 'Mythic', ?, 'BIS')"
  ).bind(teamId, c1).run();

  await D.prepare(
    "INSERT INTO bis_submissions (team_id, char_id, char_name, spec, slot, true_bis, status) " +
    "VALUES (?, ?, 'C1', 'Arms', 'Head', 'Helm', 'Approved')"
  ).bind(teamId, c1).run();

  // valid default_bis row (real item id) + valid tier/worn/summary rows
  await D.prepare(
    "INSERT INTO default_bis (spec, slot, true_bis, true_bis_item_id, raid_bis, source) " +
    "VALUES ('Arms', 'Head', 'Helm', ?, 'Helm', 'Icy Veins')"
  ).bind(itemPk).run();

  await D.prepare(
    "INSERT INTO tier_snapshot (char_id, raid_id, tier_count, tier_detail, updated_at) VALUES (?, ?, 2, 'Head:Mythic', '2026-01-02')"
  ).bind(c1, raidPk).run();

  await D.prepare(
    "INSERT INTO worn_bis (char_id, slot, spec, overall_bis_track, updated_at) VALUES (?, 'Head', 'Arms', 'Mythic', '2026-01-02')"
  ).bind(c1).run();

  await D.prepare(
    "INSERT INTO loot_summary (team_id, char_id, bis_mythic, last_updated) VALUES (?, ?, 1, '2026-01-02')"
  ).bind(teamId, c1).run();

  // ── 3b. seed deliberately ORPHANED rows (FK enforcement temporarily off) ─────
  withForeignKeysOff(D, (raw) => {
    // tier_snapshot for a real char but a raid that no longer exists → raid_id must be nulled
    raw.prepare("INSERT INTO tier_snapshot (char_id, raid_id, tier_count, tier_detail, updated_at) VALUES (?, ?, 1, 'x', 't')")
       .run(c2, NO_SUCH_RAID_ID);
    // tier_snapshot / worn_bis / loot_summary for a char that no longer exists → whole row must drop
    raw.prepare("INSERT INTO tier_snapshot (char_id, raid_id, tier_count, tier_detail, updated_at) VALUES (?, NULL, 0, '', 't')")
       .run(NO_SUCH_ROSTER_ID);
    raw.prepare("INSERT INTO worn_bis (char_id, slot, spec, updated_at) VALUES (?, 'Head', 'Arms', 't')")
       .run(NO_SUCH_ROSTER_ID);
    raw.prepare("INSERT INTO loot_summary (team_id, char_id, last_updated) VALUES (?, ?, 't')")
       .run(teamId, NO_SUCH_ROSTER_ID);
    // default_bis pointing at an item id that no longer exists → item id must be nulled, row kept
    raw.prepare("INSERT INTO default_bis (spec, slot, true_bis, true_bis_item_id, raid_bis, source) VALUES ('Fury', 'Head', 'Ghost Helm', ?, '', 'Wowhead')")
       .run(NO_SUCH_ITEM_ID);
  });

  // ── 4. apply the full migration set — 0005 runs against the dirty DB ─────────
  const all = await runMigrations(D, MIGRATIONS);
  const m0005 = all.find(r => r.name === '0005_seasons');
  assert.ok(m0005, '0005 present in results');
  assert.equal(m0005.status, 'applied', `0005 should apply cleanly, got: ${JSON.stringify(m0005)}`);
  assert.ok(all.every(r => r.status !== 'error'), `a migration errored: ${JSON.stringify(all)}`);

  // ── 5. assertions ────────────────────────────────────────────────────────────
  await t.test('seasons table seeded with current season 1', async () => {
    const s = await D.prepare('SELECT * FROM seasons WHERE id = 1').first();
    assert.ok(s, 'season 1 exists');
    assert.equal(s.is_current, 1);
  });

  await t.test('season_id added to operational tables, defaulted to 1', async () => {
    const loot = await D.prepare('SELECT season_id FROM loot_log').first();
    assert.equal(loot.season_id, 1);
    const bis = await D.prepare('SELECT season_id FROM bis_submissions').first();
    assert.equal(bis.season_id, 1);
    const raid = await D.prepare('SELECT season_id FROM raids').first();
    assert.equal(raid.season_id, 1);
  });

  await t.test('orphaned raid_id is nulled, valid raid_id preserved, orphan char dropped', async () => {
    const rows = await D.prepare('SELECT char_id, raid_id FROM tier_snapshot ORDER BY char_id').all();
    const byChar = new Map(rows.results.map(r => [r.char_id, r.raid_id]));
    assert.ok(byChar.has(c1), 'c1 tier_snapshot survives');
    assert.notEqual(byChar.get(c1), null, 'c1 valid raid_id preserved');
    assert.ok(byChar.has(c2), 'c2 tier_snapshot survives');
    assert.equal(byChar.get(c2), null, 'c2 orphaned raid_id nulled');
    assert.ok(!byChar.has(NO_SUCH_ROSTER_ID), 'orphan-char tier_snapshot dropped');
  });

  await t.test('orphan-char worn_bis and loot_summary rows dropped, valid kept', async () => {
    const wb = await D.prepare('SELECT char_id FROM worn_bis').all();
    const wbChars = wb.results.map(r => r.char_id);
    assert.ok(wbChars.includes(c1), 'valid worn_bis kept');
    assert.ok(!wbChars.includes(NO_SUCH_ROSTER_ID), 'orphan worn_bis dropped');

    const ls = await D.prepare('SELECT char_id, season_id FROM loot_summary').all();
    const lsChars = ls.results.map(r => r.char_id);
    assert.ok(lsChars.includes(c1), 'valid loot_summary kept');
    assert.ok(!lsChars.includes(NO_SUCH_ROSTER_ID), 'orphan loot_summary dropped');
    assert.equal(ls.results.find(r => r.char_id === c1).season_id, 1);
  });

  await t.test('default_bis: stale item id nulled, valid item id preserved', async () => {
    const valid = await D.prepare("SELECT true_bis_item_id FROM default_bis WHERE spec = 'Arms'").first();
    assert.equal(valid.true_bis_item_id, itemPk, 'valid item id preserved');
    const orphan = await D.prepare("SELECT true_bis_item_id FROM default_bis WHERE spec = 'Fury'").first();
    assert.equal(orphan.true_bis_item_id, null, 'stale item id nulled');
  });

  await t.test('migration is idempotent — re-running is a no-op', async () => {
    const again = await runMigrations(D, MIGRATIONS);
    assert.ok(again.every(r => r.status === 'already_applied'), `re-run should be all already_applied: ${JSON.stringify(again)}`);
  });
});
