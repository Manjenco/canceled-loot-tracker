/**
 * specs.test.js — deploy-free spec-ID overrides merged over the built-in map.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecIdOverrides, setSpecIdOverrides, specNameForId } from '../src/lib/specs.js';

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
