/**
 * specs.test.js — deploy-free spec-ID overrides merged over the built-in map.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpecIdOverrides, setSpecIdOverrides, specNameForId,
  getClassForSpec, toCanonical, ALL_SPECS, CLASS_SPECS,
  resolveVeteranStarts, buildTrackRanges, getItemTrack,
} from '../src/lib/specs.js';

test('resolveVeteranStarts scopes track detection to the season, else falls back', () => {
  const MULTI = '9544|10266|10305|12777|12825|12873'; // auto-detected, every season's Veteran start
  const SINGLE = '12777';                             // legacy single global (often stale)

  // A season that pins its own Veteran start → ONLY that block (so Worn BIS resets each season).
  assert.deepEqual(resolveVeteranStarts(12825, MULTI, SINGLE), [12825]);
  assert.deepEqual(resolveVeteranStarts('12825', MULTI, SINGLE), [12825]);

  // No season base → fall back to the multi-season list (legacy: classifies gear from any season).
  assert.deepEqual(resolveVeteranStarts(null, MULTI, SINGLE), [9544, 10266, 10305, 12777, 12825, 12873]);
  assert.deepEqual(resolveVeteranStarts('',   MULTI, SINGLE), [9544, 10266, 10305, 12777, 12825, 12873]);
  assert.deepEqual(resolveVeteranStarts(0,    MULTI, SINGLE), [9544, 10266, 10305, 12777, 12825, 12873]);

  // Multi list absent → fall back to the single global.
  assert.deepEqual(resolveVeteranStarts(null, '', SINGLE), [12777]);
  // Nothing configured → empty (all tracks read Unknown).
  assert.deepEqual(resolveVeteranStarts(null, '', ''), []);

  // The payoff: with a season base, prior-season gear (a different block) reads Unknown and drops
  // out of Worn BIS, so it resets; the multi-season fallback would classify it and carry it forward.
  const s2Ranges = resolveVeteranStarts(12825, MULTI, SINGLE).flatMap(buildTrackRanges);
  assert.equal(getItemTrack([12825 + 24], s2Ranges), 'Mythic');     // this season's Mythic gear
  assert.equal(getItemTrack([12777 + 24], s2Ranges), 'Unknown');    // last season's Mythic gear → dropped
  const legacyRanges = resolveVeteranStarts(null, MULTI, SINGLE).flatMap(buildTrackRanges);
  assert.equal(getItemTrack([12777 + 24], legacyRanges), 'Mythic'); // legacy: last season's gear still counts
});

test('getClassForSpec resolves every spec in both sheet and canonical form', () => {
  // Regression: CLASS_BY_SPEC was keyed by the short sheet names while getClassForSpec
  // looks up by toCanonical(spec). Any class whose sheet name differs from its canonical
  // name (Shaman, Death Knight, Demon Hunter, Hunter, Warlock…) missed and returned '',
  // which silently emptied the tier-piece filter on the Default BIS editor.
  const expected = {};
  for (const [cls, specs] of Object.entries(CLASS_SPECS)) for (const s of specs) expected[s] = cls;

  for (const sheet of ALL_SPECS) {
    assert.equal(getClassForSpec(sheet),            expected[sheet], `sheet form: ${sheet}`);
    assert.equal(getClassForSpec(toCanonical(sheet)), expected[sheet], `canonical form: ${toCanonical(sheet)}`);
  }
  // The exact forms the Default BIS page sends (the ones that used to break).
  assert.equal(getClassForSpec('Elemental Shaman'),   'Shaman');
  assert.equal(getClassForSpec('Frost Death Knight'), 'Death Knight');
  assert.equal(getClassForSpec('Havoc Demon Hunter'), 'Demon Hunter');
  assert.equal(getClassForSpec('unknown spec'),       ''); // still '' for genuinely unknown input
});

test('spec-id overrides', async (t) => {
  await t.test('parseSpecIdOverrides parses id:name pairs, ignores junk', () => {
    assert.deepEqual(parseSpecIdOverrides('1480:Devourer DH|62:Arcane Mage'), { '1480': 'Devourer DH', '62': 'Arcane Mage' });
    assert.deepEqual(parseSpecIdOverrides('nope|:x|7:|abc:y'), {}); // non-numeric id / empty parts dropped
    assert.deepEqual(parseSpecIdOverrides(''), {});
    assert.deepEqual(parseSpecIdOverrides(null), {});
  });

  await t.test('specNameForId: override wins, then built-in', () => {
    setSpecIdOverrides(parseSpecIdOverrides('1480:Devourer DH|250:OVERRIDDEN'));
    assert.equal(specNameForId(1480), 'Devourer DH');  // brand-new spec
    assert.equal(specNameForId(250),  'OVERRIDDEN');   // override beats built-in
    assert.equal(specNameForId(62),   'Arcane Mage');  // untouched built-in
    setSpecIdOverrides({});                             // reset module state
    assert.equal(specNameForId(250),  'Blood DK');     // back to built-in
    assert.equal(specNameForId(99999), undefined);     // unknown → undefined (caller falls back to roster)
  });
});
