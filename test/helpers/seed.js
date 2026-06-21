/**
 * seed.js — baseline fixture for the operations suite.
 *
 * Seeds a single team with a small roster, an item DB, and a couple of default
 * BIS rows into season 1 (which schema.sql already marks is_current = 1).
 * Uses real db.js writers where possible so seeding doubles as coverage.
 *
 * Returns the ids the tests need to drive assertions.
 */

import {
  addRosterChar, setRosterOwner, writeItemDb,
} from '../../src/lib/db.js';

export async function seedBaseline(db) {
  // Team
  const teamRes = await db
    .prepare('INSERT INTO teams (name) VALUES (?)')
    .bind('Test Team')
    .run();
  const teamId = teamRes.meta.last_row_id;

  // Roster — two characters with distinct owners
  const chars = [];
  const defs = [
    { charName: 'Morthrak',  cls: 'Warrior', spec: 'Arms',       role: 'DPS',  ownerId: 'owner-1', ownerNick: 'Mort' },
    { charName: 'Zephyrak',  cls: 'Mage',    spec: 'Frost Mage', role: 'DPS',  ownerId: 'owner-2', ownerNick: 'Zeph' },
  ];
  for (const d of defs) {
    const id = await addRosterChar(db, teamId, {
      charName: d.charName, cls: d.cls, spec: d.spec, role: d.role, status: 'Active',
    });
    await setRosterOwner(db, id, d.ownerId, d.ownerNick);
    chars.push({ id, name: d.charName, cls: d.cls, spec: d.spec, ownerId: d.ownerId });
  }

  // Item DB (season 1)
  await writeItemDb(db, [
    { itemId: '1001', name: 'Helm of Testing',    slot: 'Head',  sourceType: 'Raid',
      sourceName: 'Test Boss', instance: 'Test Raid', difficulty: 'Mythic', armorType: 'Plate', isTierToken: false },
    { itemId: '1002', name: 'Blade of Testing',   slot: 'Weapon', sourceType: 'Raid',
      sourceName: 'Test Boss', instance: 'Test Raid', difficulty: 'Mythic', armorType: 'Accessory', isTierToken: false },
    { itemId: '1003', name: 'Conqueror Token',    slot: 'Head',  sourceType: 'Raid',
      sourceName: 'Test Boss', instance: 'Test Raid', difficulty: 'Mythic', armorType: 'Tier Token', isTierToken: true },
  ], 1);

  // Default BIS (season 1) — one row, source "Icy Veins", linked to the helm item.
  const item = await db.prepare("SELECT id FROM item_db WHERE item_id = '1001' AND season_id = 1").first();
  await db
    .prepare(`INSERT INTO default_bis (season_id, spec, slot, true_bis, true_bis_item_id, raid_bis, raid_bis_item_id, source)
              VALUES (1, ?, 'Head', 'Helm of Testing', ?, 'Helm of Testing', ?, 'Icy Veins')`)
    .bind('Arms', item.id, item.id)
    .run();

  return { teamId, chars, helmItemId: item.id };
}
