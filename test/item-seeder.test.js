/**
 * item-seeder.test.js — tier-token detection from class-group (armor type) + slot word.
 * Token identification + armor type are name-free (robust across expansions); only the
 * slot word map is per-expansion, and an unmatched slot is skipped (logged), not guessed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierTokenInfo, mapItem, setTokenSlotOverrides, parseTokenSlotOverrides } from '../src/lib/item-seeder.js';

const tok = (name, classes, invType = 'NON_EQUIP') => ({
  id: 1,
  name,
  inventory_type: { type: invType },
  preview_item: { requirements: { playable_classes: { display_string: `Classes: ${classes.join(', ')}` } } },
});

const CLOTH   = ['Warlock', 'Mage', 'Priest'];
const LEATHER = ['Rogue', 'Monk', 'Druid', 'Demon Hunter'];
const MAIL    = ['Hunter', 'Shaman', 'Evoker'];
const PLATE   = ['Warrior', 'Paladin', 'Death Knight'];

test('tierTokenInfo', async (t) => {
  await t.test('armor type from class group + slot from Midnight word', () => {
    assert.deepEqual(tierTokenInfo(tok('Voidwoven Fanatical Nullcore', CLOTH)),  { slot: 'Head',      armorType: 'Cloth'   });
    assert.deepEqual(tierTokenInfo(tok('Alnforged Riftbloom',         PLATE)),   { slot: 'Chest',     armorType: 'Plate'   });
    assert.deepEqual(tierTokenInfo(tok('Voidcured Hungering Nullcore', LEATHER)), { slot: 'Hands',     armorType: 'Leather' });
    assert.deepEqual(tierTokenInfo(tok('Voidcast Corrupted Nullcore',  MAIL)),    { slot: 'Legs',      armorType: 'Mail'    });
    assert.deepEqual(tierTokenInfo(tok('Aetherweave Unraveled Nullcore', CLOTH)), { slot: 'Shoulders', armorType: 'Cloth'   });
  });

  await t.test('legacy descriptive token names still resolve a slot', () => {
    assert.deepEqual(tierTokenInfo(tok("Vanquisher's Helm of Doom", PLATE)), { slot: 'Head', armorType: 'Plate' });
  });

  await t.test('recognised token with unknown slot word → null (logged, not guessed)', () => {
    assert.equal(tierTokenInfo(tok('Mysterious Whatsit', CLOTH)), null);
  });

  await t.test('not a full armor class-group → not a token', () => {
    assert.equal(tierTokenInfo(tok('Class Quest Reward', ['Mage'])), null);            // single class
    assert.equal(tierTokenInfo(tok('Random Junk', [])), null);                          // no restriction
  });

  await t.test('equippable item is never a token (must be NON_EQUIP)', () => {
    assert.equal(tierTokenInfo(tok('Hood of Testing', CLOTH, 'HEAD')), null);
  });

  await t.test('token-slot overrides merge over the built-in word map (deploy-free)', () => {
    assert.deepEqual(parseTokenSlotOverrides('Mysterious:Shoulders|Glimmering:Hands'), { Mysterious: 'Shoulders', Glimmering: 'Hands' });
    setTokenSlotOverrides(parseTokenSlotOverrides('Mysterious:Shoulders'));
    assert.deepEqual(tierTokenInfo(tok('Aetherweave Mysterious Relic', CLOTH)), { slot: 'Shoulders', armorType: 'Cloth' }); // override resolves a new word
    assert.deepEqual(tierTokenInfo(tok('Voidwoven Fanatical Nullcore', CLOTH)), { slot: 'Head', armorType: 'Cloth' });        // built-in still works
    setTokenSlotOverrides({}); // reset module state for other tests
  });

  await t.test('mapItem emits a tier-token row for a token', () => {
    const row = mapItem({ details: tok('Voidwoven Fanatical Nullcore', CLOTH), encounterName: 'Boss', instanceName: 'Raid', difficulty: 'MYTHIC' });
    assert.equal(row.slot, 'Head');
    assert.equal(row.armorType, 'Cloth');
    assert.equal(row.isTierToken, true);
    assert.equal(row.sourceType, 'Raid');
  });
});
