/**
 * item-seeder.test.js — the Mythic+ seasonal-loot filter.
 *
 * Mirrors the real shapes observed from the journal API:
 *   - Algeth'ar Academy (imported old dungeon): real loot at ilvl 250 + a couple of
 *     off-season stragglers at ilvl 108 + NON_EQUIP cypher/decor junk.
 *   - Eco-Dome Al'dani (current dungeon): a clean uniform set at one ilvl.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterSeasonalMplusItems } from '../src/lib/item-seeder.js';

const wrap = (id, ilvl, invType = 'CHEST') => ({
  details: { id, level: ilvl, inventory_type: { type: invType } },
});

test('filterSeasonalMplusItems', async (t) => {
  await t.test('keeps the top-ilvl cluster, drops lower stragglers + NON_EQUIP', () => {
    const raw = [
      ...Array.from({ length: 22 }, (_, i) => wrap(193000 + i, 250)), // real seasonal loot
      wrap(258529, 108, 'TWOHWEAPON'),                                // off-season straggler
      wrap(258531, 108, 'SHIELD'),                                    // off-season straggler
      wrap(198056, 62, 'NON_EQUIP'),                                  // cypher junk
      wrap(260359, 1,  'NON_EQUIP'),                                  // housing decor junk
    ];
    const out = filterSeasonalMplusItems(raw);
    assert.equal(out.length, 22);
    assert.ok(out.every(r => r.details.level === 250), 'only max-ilvl items kept');
    assert.ok(!out.some(r => r.details.id === 258529), 'straggler dropped');
  });

  await t.test('is a no-op on a clean current dungeon (uniform ilvl)', () => {
    const raw = Array.from({ length: 22 }, (_, i) => wrap(242000 + i, 437));
    assert.equal(filterSeasonalMplusItems(raw).length, 22);
  });

  await t.test('drops NON_EQUIP even when ilvl is uniform', () => {
    const raw = [wrap(1, 437), wrap(2, 437, 'NON_EQUIP')];
    const out = filterSeasonalMplusItems(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0].details.id, 1);
  });

  await t.test('empty / all-junk input → empty', () => {
    assert.deepEqual(filterSeasonalMplusItems([]), []);
    assert.deepEqual(filterSeasonalMplusItems([wrap(9, 5, 'NON_EQUIP')]), []);
  });
});
