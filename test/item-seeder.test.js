/**
 * item-seeder.test.js — tier-token detection from class-group (armor type) + slot word.
 * Token identification + armor type are name-free (robust across expansions); only the
 * slot word map is per-expansion, and an unmatched slot is skipped (logged), not guessed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierTokenInfo, mapItem, mapDb2Item, setTokenSlotOverrides, parseTokenSlotOverrides } from '../src/lib/item-seeder.js';

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

  await t.test('Midnight S2 (Venomous Abyss) token words resolve to the right slot', () => {
    // Verified from each token's tooltip ("Create a soulbound set <slot> item…").
    assert.deepEqual(tierTokenInfo(tok('Venomforged Effigy',  PLATE)),   { slot: 'Head',      armorType: 'Plate'   });
    assert.deepEqual(tierTokenInfo(tok('Venomcured Remnant',  LEATHER)), { slot: 'Shoulders', armorType: 'Leather' });
    assert.deepEqual(tierTokenInfo(tok('Venomcast Icon',      MAIL)),    { slot: 'Chest',     armorType: 'Mail'    });
    assert.deepEqual(tierTokenInfo(tok('Venomwoven Idol',     CLOTH)),   { slot: 'Hands',     armorType: 'Cloth'   });
    assert.deepEqual(tierTokenInfo(tok('Venomforged Relic',   PLATE)),   { slot: 'Legs',      armorType: 'Plate'   });
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

// ── DB2 mapper (mapDb2Item) — same rows as mapItem, from raw ItemSparse + Item ──────
const db2 = (sparse, item, difficulty = 'MYTHIC') =>
  mapDb2Item({ sparse, item, encounterName: 'Boss', instanceName: 'The Venomous Abyss', difficulty });

test('mapDb2Item', async (t) => {
  await t.test('plate chest → Chest / Plate, not a token', () => {
    const r = db2({ ID: '100', Display_lang: 'Breastplate', InventoryType: '5', ItemSet: '0', AllowableClass: '35' }, { ClassID: '4', SubclassID: '4' });
    assert.equal(r.slot, 'Chest');
    assert.equal(r.armorType, 'Plate');
    assert.equal(r.isTierToken, false);
    assert.equal(r.itemId, '100');
  });

  await t.test('cloth robe (InventoryType 20) → Chest / Cloth', () => {
    const r = db2({ ID: '101', Display_lang: 'Robe', InventoryType: '20', ItemSet: '0' }, { ClassID: '4', SubclassID: '1' });
    assert.equal(r.slot, 'Chest');
    assert.equal(r.armorType, 'Cloth');
  });

  await t.test('one-hand sword → Weapon / Accessory / weaponType Sword', () => {
    const r = db2({ ID: '102', Display_lang: 'Blade', InventoryType: '13', ItemSet: '0' }, { ClassID: '2', SubclassID: '7' });
    assert.equal(r.slot, 'Weapon');
    assert.equal(r.armorType, 'Accessory');
    assert.equal(r.weaponType, 'Sword');
  });

  await t.test('shield (InventoryType 14) → Off-Hand / weaponType Shield', () => {
    const r = db2({ ID: '103', Display_lang: 'Bulwark', InventoryType: '14', ItemSet: '0' }, { ClassID: '4', SubclassID: '6' });
    assert.equal(r.slot, 'Off-Hand');
    assert.equal(r.weaponType, 'Shield');
  });

  await t.test('trinket → Trinket / Accessory', () => {
    const r = db2({ ID: '104', Display_lang: 'Idol of Power', InventoryType: '12', ItemSet: '0' }, { ClassID: '4', SubclassID: '0' });
    assert.equal(r.slot, 'Trinket');
    assert.equal(r.armorType, 'Accessory');
  });

  await t.test('tier-set armor (ItemSet != 0 on a tier slot) → isTierToken true', () => {
    const r = db2({ ID: '105', Display_lang: 'Jade Warlord Helm', InventoryType: '1', ItemSet: '2067' }, { ClassID: '4', SubclassID: '4' });
    assert.equal(r.slot, 'Head');
    assert.equal(r.isTierToken, true);
  });

  await t.test('NON_EQUIP tier token: armor from AllowableClass, slot from word override', () => {
    setTokenSlotOverrides(parseTokenSlotOverrides('Idol:Chest'));
    const r = db2({ ID: '270913', Display_lang: 'Venomforged Idol', InventoryType: '0', ItemSet: '0', AllowableClass: '35' }, { ClassID: '15', SubclassID: '0' });
    assert.equal(r.slot, 'Chest');       // from the Idol→Chest override
    assert.equal(r.armorType, 'Plate');  // from AllowableClass 35
    assert.equal(r.isTierToken, true);
    setTokenSlotOverrides({});
  });

  await t.test('NON_EQUIP with no armor-class-group → skipped (null)', () => {
    assert.equal(db2({ ID: '106', Display_lang: 'Some Quest Item', InventoryType: '0', AllowableClass: '0' }, { ClassID: '15', SubclassID: '0' }), null);
  });

  await t.test('unmapped inventory type (Bag=18) → null', () => {
    assert.equal(db2({ ID: '107', Display_lang: 'Big Bag', InventoryType: '18' }, { ClassID: '1', SubclassID: '0' }), null);
  });

  await t.test('missing ItemSparse row → null', () => {
    assert.equal(db2(undefined, { ClassID: '4', SubclassID: '4' }), null);
  });

  await t.test('M+ difficulty tags sourceType Mythic+', () => {
    const r = db2({ ID: '108', Display_lang: 'Ring', InventoryType: '11', ItemSet: '0' }, { ClassID: '4', SubclassID: '0' }, 'MYTHIC_KEYSTONE');
    assert.equal(r.slot, 'Ring');
    assert.equal(r.sourceType, 'Mythic+');
    assert.equal(r.difficulty, 'Mythic+');
  });
});
