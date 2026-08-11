/**
 * wcl.test.js — pure WCL helpers (no network). Covers guessRaidZone's name/boss matching
 * used by the season zone-ID picker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessRaidZone } from '../src/lib/wcl.js';

const ZONES = [
  { id: 50, name: 'Sporefall',   frozen: false, encounters: ['Rotmire'] },
  { id: 46, name: 'VS / DR / MQD', frozen: false, encounters: ['Imperator Averzian', 'Midnight Falls'] },
  { id: 51, name: 'The Venomous Abyss', frozen: false, encounters: ['Ula\'tek', 'Nymrissa Wavecaller', 'Vashnik the Malignant'] },
];

test('guessRaidZone', async (t) => {
  await t.test('exact zone-name match wins (ignoring a leading "The")', () => {
    const g = guessRaidZone(ZONES, { raidInstanceNames: ['The Venomous Abyss'] });
    assert.equal(g?.zoneId, '51');
  });

  await t.test('boss-name overlap identifies the zone when the name differs', () => {
    const zones = [
      { id: 46, name: 'VS / DR / MQD', frozen: false, encounters: ['Imperator Averzian'] },
      { id: 51, name: 'Beta Placeholder', frozen: false, encounters: ["Ula'tek", 'Nymrissa Wavecaller'] },
    ];
    const g = guessRaidZone(zones, { raidBossNames: ["Ula'tek", 'Nymrissa Wavecaller', 'Vashnik the Malignant'] });
    assert.equal(g?.zoneId, '51');
    assert.equal(g?.bossHits, 2);
  });

  await t.test('no overlap → null (pre-launch: only PTR placeholder zones exist)', () => {
    // S2's raid isn't on WCL yet; none of the listed zones match its instance/bosses.
    const g = guessRaidZone(
      [{ id: 46, name: 'VS / DR / MQD', frozen: false, encounters: ['Imperator Averzian', 'Midnight Falls'] },
       { id: 50, name: 'Sporefall', frozen: false, encounters: ['Rotmire'] }],
      { raidInstanceNames: ['The Venomous Abyss', 'The Tidebound Grotto'], raidBossNames: ["Ula'tek", 'Nymrissa Wavecaller'] },
    );
    assert.equal(g, null);
  });

  await t.test('empty hints → null (nothing to match on)', () => {
    assert.equal(guessRaidZone(ZONES, {}), null);
    assert.equal(guessRaidZone(ZONES), null);
  });
});
