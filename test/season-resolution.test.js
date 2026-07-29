/**
 * season-resolution.test.js — getCurrentSeason: manual override wins, else the newest
 * non-pre-release season whose start_date has passed (empty = long-passed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFreshDb } from './helpers/test-db.js';
import * as db from '../src/lib/db.js';

test('current-season resolution', async (t) => {
  const D = createFreshDb(); // schema seeds season 1: empty start_date, is_current = 0

  await t.test('lone Season 1 (empty date, no override) resolves as current', async () => {
    assert.equal(await db.getCurrentSeasonId(D), 1);
  });

  let s2;
  await t.test('a passed start_date beats an empty one', async () => {
    s2 = await db.createSeason(D, { name: 'S2', startDate: '2000-01-01' });
    assert.equal(await db.getCurrentSeasonId(D), s2);
  });

  await t.test('a future start_date is not current', async () => {
    const s3 = await db.createSeason(D, { name: 'S3-future', startDate: '2999-01-01' });
    assert.equal(await db.getCurrentSeasonId(D), s2); // still S2, not the future S3
    assert.notEqual(await db.getCurrentSeasonId(D), s3);
  });

  await t.test('a pre-release season is never auto-current, even with a later passed date', async () => {
    const s4 = await db.createSeason(D, { name: 'S4-pre', startDate: '2001-01-01' });
    await db.updateSeason(D, s4, { preRelease: true });
    assert.equal(await db.getCurrentSeasonId(D), s2); // S4 excluded despite 2001 > 2000
  });

  await t.test('manual override wins over the date rule', async () => {
    await db.setCurrentSeason(D, 1);
    assert.equal(await db.getCurrentSeasonId(D), 1);
  });

  await t.test('clearing the override reverts to the date rule', async () => {
    await db.clearCurrentSeasonOverride(D);
    assert.equal(await db.getCurrentSeasonId(D), s2);
  });
});
