/**
 * operations.test.js — exercises the db.js data layer against a fresh
 * season-partitioned schema. Verifies each major read/write path still works
 * with the season_id argument threaded through, and — most importantly — that
 * data written to one season is invisible to reads of another.
 *
 * Runs in its own process (node --test), so db.js's module-level cache is not
 * shared with other test files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFreshDb, foreignKeysEnabled } from './helpers/test-db.js';
import { seedBaseline } from './helpers/seed.js';
import * as db from '../src/lib/db.js';

test('data layer operations (season-partitioned)', async (t) => {
  const D = createFreshDb();
  assert.ok(foreignKeysEnabled(D), 'FK enforcement must be ON to match D1');

  const { teamId, chars, helmItemId } = await seedBaseline(D);
  const [c1, c2] = chars;

  await t.test('current season resolves to 1', async () => {
    assert.equal(await db.getCurrentSeasonId(D), 1);
    const s = await db.getCurrentSeason(D);
    assert.equal(s.id, 1);
    assert.equal(s.is_current, 1);
  });

  await t.test('roster reads back seeded characters', async () => {
    const roster = await db.getRoster(D, teamId);
    assert.equal(roster.length, 2);
    const names = roster.map(r => r.char_name).sort();
    assert.deepEqual(names, ['Morthrak', 'Zephyrak']);
    assert.equal(roster.find(r => r.char_name === 'Morthrak').owner_id, 'owner-1');
  });

  await t.test('item DB reads back, including tier token', async () => {
    const items = await db.getItemDb(D, 1);
    assert.equal(items.length, 3);
    assert.ok(items.some(i => i.is_tier_token === 1));
  });

  await t.test('append loot + summary aggregates by type/difficulty', async () => {
    await db.appendLootEntries(D, teamId, [
      { date: '2026-02-01', boss: 'Test Boss', itemName: 'Helm of Testing',  difficulty: 'Mythic', recipientCharId: c1.id, recipientChar: c1.name, upgradeType: 'BIS' },
      { date: '2026-02-02', boss: 'Test Boss', itemName: 'Blade of Testing', difficulty: 'Heroic', recipientCharId: c1.id, recipientChar: c1.name, upgradeType: 'Non-BIS' },
      { date: '2026-02-03', boss: 'Test Boss', itemName: 'Trinket',          difficulty: 'Mythic', recipientCharId: c1.id, recipientChar: c1.name, upgradeType: 'Tertiary' },
    ], 1);

    const log = await db.getLootLog(D, teamId, 1);
    assert.equal(log.length, 3);
    assert.ok(log.every(e => 'itemName' in e), 'parseLootRow camelCase alias present');

    const summary = await db.getLootSummary(D, teamId, 1);
    const s = summary.find(x => x.char_id === c1.id);
    assert.ok(s, 'summary row for c1 exists');
    assert.equal(s.bis_mythic, 1);
    assert.equal(s.nonbis_heroic, 1);
    assert.equal(s.tertiary, 1);
  });

  await t.test('per-character loot read matches', async () => {
    const loot = await db.getLootLogForChar(D, teamId, c1.id, c1.name, 1);
    assert.equal(loot.length, 3);
  });

  await t.test('BIS submission upsert, read, approve', async () => {
    await db.upsertBisSubmission(D, teamId, 1, {
      charId: c1.id, charName: c1.name, spec: c1.spec, slot: 'Head',
      trueBis: 'Helm of Testing', raidBis: '<Tier>', rationale: 'best in slot',
    });
    let subs = await db.getBisSubmissions(D, teamId, 1);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].status, 'Pending');

    // upsert again (same season/team/char/slot) must update, not duplicate
    await db.upsertBisSubmission(D, teamId, 1, {
      charId: c1.id, charName: c1.name, spec: c1.spec, slot: 'Head',
      trueBis: 'Helm of Testing', raidBis: 'Helm of Testing', rationale: 'changed mind',
    });
    subs = await db.getBisSubmissions(D, teamId, 1);
    assert.equal(subs.length, 1, 'upsert conflict key includes season_id — no duplicate');

    await db.approveBisSubmission(D, subs[0].id, 'officer-1', c1.id);
    db.invalidateBisSubmissionsCache();
    const after = await db.getBisSubmissions(D, teamId, 1);
    assert.equal(after[0].status, 'Approved');
  });

  await t.test('effective default BIS resolves for a spec', async () => {
    const rows = await db.getEffectiveDefaultBisForSpec(D, 1, 'Arms');
    const head = rows.find(r => r.slot === 'Head');
    assert.ok(head, 'Arms Head default exists');
    assert.equal(head.true_bis, 'Helm of Testing');
  });

  await t.test('raids upsert + read with attendees', async () => {
    await db.upsertRaids(D, teamId, [
      { raidId: 'RPT001', date: '2026-02-01', instance: 'Test Raid', difficulty: 'Mythic', attendeeIds: [c1.ownerId, c2.ownerId] },
    ], 1);
    const raids = await db.getRaids(D, teamId, 1);
    assert.equal(raids.length, 1);
    assert.deepEqual(raids[0].attendeeIds.sort(), ['owner-1', 'owner-2']);
  });

  await t.test('tier snapshot upsert + read (joins roster)', async () => {
    await db.upsertTierSnapshot(D, teamId, [
      { charId: c1.id, raidId: 'RPT001', tierCount: 2, tierDetail: 'Head:Mythic|Chest:Hero', updatedAt: '2026-02-01' },
    ], 1);
    const ts = await db.getTierSnapshot(D, teamId, 1);
    assert.equal(ts.length, 1);
    assert.equal(ts[0].tier_count, 2);
    assert.equal(ts[0].char_name, c1.name);
  });

  await t.test('worn BIS upsert + read (keyed map)', async () => {
    await db.upsertWornBis(D, teamId, [
      { charId: c1.id, slot: 'Head', spec: c1.spec, overallBISTrack: 'Mythic', raidBISTrack: 'Hero', otherTrack: '', updatedAt: '2026-02-01' },
    ], 1);
    const wb = await db.getWornBis(D, teamId, 1);
    assert.equal(wb.size, 1);
    const row = wb.get(`${c1.id}:${c1.spec}:Head`);
    assert.ok(row, 'composite-keyed worn_bis entry present');
    assert.equal(row.overall_bis_track, 'Mythic');
  });

  // ── The crux of season partitioning: cross-season isolation ────────────────
  await t.test('season 2 data is fully isolated from season 1', async () => {
    const s2 = await db.createSeason(D, { name: 'Season 2', startDate: '2026-06-01', isCurrent: false });
    assert.ok(s2 > 1, 'new season id allocated');

    // Write loot, item DB, BIS, raids into season 2 only
    await db.writeItemDb(D, [
      { itemId: '2001', name: 'S2 Relic', slot: 'Trinket', sourceType: 'Raid', sourceName: 'S2 Boss',
        instance: 'S2 Raid', difficulty: 'Mythic', armorType: 'Accessory', isTierToken: false },
    ], s2);
    await db.appendLootEntries(D, teamId, [
      { date: '2026-06-10', boss: 'S2 Boss', itemName: 'S2 Relic', difficulty: 'Mythic', recipientCharId: c1.id, recipientChar: c1.name, upgradeType: 'BIS' },
    ], s2);
    await db.upsertBisSubmission(D, teamId, s2, {
      charId: c1.id, charName: c1.name, spec: c1.spec, slot: 'Trinket 1',
      trueBis: 'S2 Relic', raidBis: 'S2 Relic', rationale: 's2',
    });

    // Season 1 reads must NOT see any season 2 data
    const s1items = await db.getItemDb(D, 1);
    assert.ok(!s1items.some(i => i.name === 'S2 Relic'), 'season 1 item DB excludes season 2 item');

    const s1loot = await db.getLootLog(D, teamId, 1);
    assert.ok(!s1loot.some(e => e.itemName === 'S2 Relic'), 'season 1 loot excludes season 2 drop');

    const s1subs = await db.getBisSubmissions(D, teamId, 1);
    assert.ok(!s1subs.some(s => s.true_bis === 'S2 Relic'), 'season 1 BIS excludes season 2 submission');

    // Season 2 reads see exactly their own data
    const s2items = await db.getItemDb(D, s2);
    assert.equal(s2items.length, 1);
    assert.equal(s2items[0].name, 'S2 Relic');

    const s2loot = await db.getLootLog(D, teamId, s2);
    assert.equal(s2loot.length, 1);
    assert.equal(s2loot[0].itemName, 'S2 Relic');

    const s2summary = await db.getLootSummary(D, teamId, s2);
    assert.equal(s2summary.find(x => x.char_id === c1.id).bis_mythic, 1);

    // Flipping current season changes getCurrentSeasonId but not historical data
    await db.setCurrentSeason(D, s2);
    assert.equal(await db.getCurrentSeasonId(D), s2);
    await db.setCurrentSeason(D, 1);
    assert.equal(await db.getCurrentSeasonId(D), 1);
  });
});
