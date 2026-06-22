/**
 * wago.test.js — the DB2 current-season M+ loot rule (pure logic), with fixtures
 * mirroring real JournalEncounterItem shapes:
 *   - Skyreach (476): current gated WSE 50188, prior-season gated 50187, WoD base DiffMask=3
 *   - Algeth'ar (1201): WSE-0 reuse + one 50188-gated item
 *   - native (1303): WSE-0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWagoCsv, computeMplusItemPicks, detectSeasonWse, findInstanceId, tierSetCandidates } from '../src/lib/wago.js';

const encounters = [
  { ID: '965',  JournalInstanceID: '476',  Name_lang: 'Ranjit' },
  { ID: '2509', JournalInstanceID: '1201', Name_lang: 'Vexamus' },
  { ID: '2675', JournalInstanceID: '1303', Name_lang: 'Azhiccar' },
];

const ei = (JournalEncounterID, ItemID, DifficultyMask, WorldStateExpressionID) =>
  ({ JournalEncounterID, ItemID, DifficultyMask, WorldStateExpressionID });

const encounterItems = [
  ei('965', '258574', '-1', '50188'),  // Skyreach current
  ei('965', '258046', '-1', '50188'),  // Skyreach current
  ei('965', '258574', '-1', '50188'),  // duplicate → deduped
  ei('965', '109784', '-1', '50187'),  // Skyreach prior season → drop
  ei('965', '109825', '3',  '0'),      // Skyreach WoD base → drop (DifficultyMask)
  ei('2509', '193710', '-1', '0'),     // Algeth'ar WSE-0 reuse → keep
  ei('2509', '258529', '-1', '50188'), // Algeth'ar gated current → keep
  ei('2675', '242468', '-1', '0'),     // native → keep
];

const ids = (picks) => picks.map(p => p.itemId).sort();

test('wago M+ rule', async (t) => {
  await t.test('Skyreach: keeps current-WSE, drops prior-season + DiffMask base', () => {
    const picks = computeMplusItemPicks(encounters, encounterItems, 476, 50188);
    assert.deepEqual(ids(picks), ['258046', '258574']);
    assert.ok(!picks.some(p => p.itemId === '109784'), 'prior-season (50187) dropped');
    assert.ok(!picks.some(p => p.itemId === '109825'), 'WoD base (DifficultyMask=3) dropped');
    assert.equal(picks[0].encounterName, 'Ranjit');
  });

  await t.test('Algeth\'ar: keeps both WSE-0 reuse and current-gated item', () => {
    assert.deepEqual(ids(computeMplusItemPicks(encounters, encounterItems, 1201, 50188)), ['193710', '258529']);
  });

  await t.test('native dungeon: keeps WSE-0 set', () => {
    assert.deepEqual(ids(computeMplusItemPicks(encounters, encounterItems, 1303, 50188)), ['242468']);
  });

  await t.test('wrong season WSE flips which gated rows survive', () => {
    // With 50187 as "current", Skyreach keeps the prior-season item, not the 50188 ones.
    assert.deepEqual(ids(computeMplusItemPicks(encounters, encounterItems, 476, 50187)), ['109784']);
  });

  await t.test('unknown instance → empty', () => {
    assert.deepEqual(computeMplusItemPicks(encounters, encounterItems, 999, 50188), []);
  });

  await t.test('detectSeasonWse ranks the shared gate first', () => {
    const ranked = detectSeasonWse(encounters, encounterItems, [476, 1201]);
    assert.equal(ranked[0].wse, 50188);
    assert.equal(ranked[0].dungeonCount, 2);          // both Skyreach + Algeth'ar
    assert.ok((ranked.find(r => r.wse === 50187)?.dungeonCount ?? 0) <= 1); // prior season only Skyreach
  });

  await t.test('parseWagoCsv handles quoted fields with commas', () => {
    const rows = parseWagoCsv('ID,Name_lang\n476,Skyreach\n1194,"Tazavesh, the Veiled Market"');
    assert.equal(rows.length, 2);
    assert.equal(rows[1].Name_lang, 'Tazavesh, the Veiled Market');
    assert.equal(findInstanceId(rows, 'Tazavesh, the Veiled Market'), '1194');
  });

  await t.test('tierSetCandidates: keeps 5-item non-DNT sets, newest first', () => {
    const set = (ID, Name_lang, SetFlags, items) => {
      const o = { ID: String(ID), Name_lang, SetFlags: String(SetFlags) };
      for (let i = 0; i <= 16; i++) o[`ItemID_${i}`] = String(items[i] ?? 0);
      return o;
    };
    const rows = [
      set(2067, 'Jade Warlord (future)', 0, [271459, 271457, 271456, 271455, 271454]),
      set(1990, 'Rage of the Night Ender', 0, [249955, 249953, 249952, 249951, 249950]),
      set(2052, '[DNT] War Mode Set', 4, [0, 0, 0, 0, 0]),               // system → out
      set(2070, 'Bite of Zul\'jan', 0, [270173, 268209, 268213]),        // 3 items → out
    ];
    const cands = tierSetCandidates(rows);
    assert.deepEqual(cands.map(c => c.id), [2067, 1990]);                // sorted desc, noise removed
    assert.equal(cands[0].items.length, 5);
  });

  await t.test('parseWagoCsv handles NEWLINES inside quoted cells (the real DB2 bug)', () => {
    // A multi-line Description_lang must not desync the rows that follow it.
    const csv =
      'ID,JournalInstanceID,Description_lang\n' +
      '2509,1201,"Line one.\nLine two, with comma."\n' +
      '2510,1201,Simple';
    const rows = parseWagoCsv(csv);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].JournalInstanceID, '1201');           // not garbled by the embedded newline
    assert.equal(rows[1].ID, '2510');                          // the next row stays aligned
    assert.equal(rows[1].JournalInstanceID, '1201');
  });
});
