/**
 * admin-items.js — Item DB and Tier Items seeding endpoints.
 *
 * All endpoints require global officer access.
 *
 * GET  /api/admin/item-db/stats           — current row counts
 * GET  /api/admin/item-db/instances       — list Blizzard journal instances
 * POST /api/admin/item-db/sync            — fetch a journal instance → write item_db
 * POST /api/admin/item-db/clear           — wipe item_db
 * POST /api/admin/tier-items/sync         — fetch item sets → write tier_items
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import { getGlobalConfig, writeItemDb, setTierItems, getTierItems, getItemDb, getCurrentSeasonId, getSeasons } from '../../../lib/db.js';
import { listInstances, getInstance, fetchRaidItems, getItemSet, getItemDetails, pLimit }
  from '../../../lib/blizzard-worker.js';
import { mapItem, TIER_ITEM_SLOT_MAP } from '../../../lib/item-seeder.js';

const router = new Hono();

router.use('*', requireAuth);

// ── Auth helper ───────────────────────────────────────────────────────────────

function requireGlobalOfficer(c, next) {
  if (!c.get('session').user?.isGlobalOfficer) {
    return c.json({ error: 'Global officer access required.' }, 403);
  }
  return next();
}

router.use('*', requireGlobalOfficer);

// ── Season resolution ─────────────────────────────────────────────────────────
// Item DB and tier items are season-scoped. Seeding targets a chosen season so an
// empty new season can be populated before it's made current. When no season is
// supplied, default to the current one. A supplied season must actually exist —
// otherwise the season_id FK on item_db / tier_items would be violated.

async function resolveSeasonId(db, requested) {
  if (requested === undefined || requested === null || requested === '') {
    return getCurrentSeasonId(db);
  }
  const id = Number(requested);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid seasonId: ${requested}`);
  const seasons = await getSeasons(db);
  if (!seasons.some(s => s.id === id)) throw new Error(`Season ${id} does not exist`);
  return id;
}

// ── Blizzard creds helper ─────────────────────────────────────────────────────

async function getBlizzardCreds(db, env) {
  const config = await getGlobalConfig(db);
  const clientId     = config.blizzard_client_id     || env.BLIZZARD_CLIENT_ID     || '';
  const clientSecret = config.blizzard_client_secret || env.BLIZZARD_CLIENT_SECRET || '';
  const region       = config.blizzard_region        || env.BLIZZARD_REGION        || 'us';
  if (!clientId || !clientSecret) {
    throw new Error(
      'Blizzard credentials not configured. Set BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET ' +
      'as Worker secrets (wrangler secret put BLIZZARD_CLIENT_SECRET).'
    );
  }
  return { clientId, clientSecret, region };
}

// ── GET /stats ────────────────────────────────────────────────────────────────

router.get('/stats', async (c) => {
  const db = c.env.DB;
  try {
    const seasonId = await resolveSeasonId(db, c.req.query('seasonId'));
    const [itemDbRow, tierRow] = await Promise.all([
      db.prepare('SELECT COUNT(*) AS n FROM item_db   WHERE season_id = ?').bind(seasonId).first(),
      db.prepare('SELECT COUNT(*) AS n FROM tier_items WHERE season_id = ?').bind(seasonId).first(),
    ]);
    return c.json({ seasonId, itemDb: itemDbRow?.n ?? 0, tierItems: tierRow?.n ?? 0 });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ── GET /list ─────────────────────────────────────────────────────────────────
// Full item list for a season — drives the admin item viewer. Reuses the cached
// getItemDb read so it stays coherent with the rest of the app. Filtering/sorting
// is done client-side (a season is a few hundred rows, well within one payload).

router.get('/list', async (c) => {
  const db = c.env.DB;
  try {
    const seasonId = await resolveSeasonId(db, c.req.query('seasonId'));
    const items = await getItemDb(db, seasonId);
    return c.json({ seasonId, items });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ── GET /instances ────────────────────────────────────────────────────────────
// Returns a lightweight list for the instance picker (id + name only).

router.get('/instances', async (c) => {
  const db = c.env.DB;
  try {
    const creds = await getBlizzardCreds(db, c.env);
    const raw   = await listInstances(creds);
    // Return id + name only — the full object is large
    const instances = raw.map(i => ({ id: i.id, name: i.name }));
    return c.json({ instances });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /sync ────────────────────────────────────────────────────────────────
// Body: { instanceId: number, difficulty: string, replace?: boolean }
// difficulty: MYTHIC | HEROIC | NORMAL | LOOKING_FOR_RAID | MYTHIC_KEYSTONE

router.post('/sync', async (c) => {
  const db = c.env.DB;
  const { instanceId, difficulty = 'MYTHIC', replace = false, seasonId: reqSeason } = await c.req.json();

  if (!instanceId) return c.json({ error: 'instanceId is required' }, 400);

  const VALID_DIFFICULTIES = ['MYTHIC', 'HEROIC', 'NORMAL', 'LOOKING_FOR_RAID', 'MYTHIC_KEYSTONE'];
  if (!VALID_DIFFICULTIES.includes(difficulty)) {
    return c.json({ error: `difficulty must be one of: ${VALID_DIFFICULTIES.join(', ')}` }, 400);
  }

  try {
    const seasonId = await resolveSeasonId(db, reqSeason);
    const creds = await getBlizzardCreds(db, c.env);

    // Fetch items from Blizzard
    const raw   = await fetchRaidItems(Number(instanceId), difficulty, creds);
    const items = raw.map(mapItem).filter(Boolean);

    if (!items.length) {
      return c.json({ ok: true, written: 0, skipped: 0, total: 0, instanceName: '(unknown)', message: 'No mappable items found for this instance/difficulty.' });
    }

    // Deduplicate (same item might appear under multiple encounters)
    const seen      = new Set();
    const deduped   = items.filter(item => {
      if (seen.has(item.itemId)) return false;
      seen.add(item.itemId);
      return true;
    });

    const instanceName = deduped[0]?.instance ?? String(instanceId);

    // Write to D1 — writeItemDb handles upserts (ON CONFLICT DO UPDATE)
    await writeItemDb(db, deduped, seasonId, { replace });

    return c.json({
      ok: true,
      total:        deduped.length,
      instanceName,
      difficulty,
      seasonId,
    });
  } catch (err) {
    console.error('[admin-items] item-db/sync error:', err);
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /clear ───────────────────────────────────────────────────────────────

router.post('/clear', async (c) => {
  const db = c.env.DB;
  try {
    const { seasonId: reqSeason } = await c.req.json().catch(() => ({}));
    const seasonId = await resolveSeasonId(db, reqSeason);
    await writeItemDb(db, [], seasonId, { replace: true });
    return c.json({ ok: true, seasonId });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ── Tier items sub-routes ─────────────────────────────────────────────────────

// POST /api/admin/tier-items/sync
// Body: { sets: [{ setId: number, className: string }] }

const tierRouter = new Hono();
tierRouter.use('*', requireAuth);
tierRouter.use('*', requireGlobalOfficer);

tierRouter.post('/sync', async (c) => {
  const db = c.env.DB;
  const { sets, seasonId: reqSeason } = await c.req.json();

  if (!Array.isArray(sets) || !sets.length) {
    return c.json({ error: 'sets must be a non-empty array of { setId, className } objects' }, 400);
  }

  for (const s of sets) {
    if (!s.setId || !s.className) {
      return c.json({ error: 'Each entry in sets must have setId (number) and className (string)' }, 400);
    }
  }

  try {
    const seasonId = await resolveSeasonId(db, reqSeason);
    const creds = await getBlizzardCreds(db, c.env);

    const allRows    = [];
    const errors     = [];
    const setResults = [];

    for (const { setId, className } of sets) {
      let setData;
      try {
        setData = await getItemSet(Number(setId), creds);
      } catch (err) {
        errors.push(`Set ${setId} (${className}): ${err.message}`);
        continue;
      }

      const items = setData.items ?? [];

      // Fetch full details for each item in the set (bounded to 5 concurrent)
      const detailed = await pLimit(
        items.map(item => async () => {
          const id = item.id ?? item.item?.id;
          try {
            return await getItemDetails(Number(id), creds);
          } catch {
            return null;
          }
        }),
        5,
      );

      const rows = [];
      for (const details of detailed.filter(Boolean)) {
        const invType = details.inventory_type?.type;
        const slot    = TIER_ITEM_SLOT_MAP[invType];
        if (slot) rows.push({ class: className, slot, itemId: String(details.id) });
      }

      allRows.push(...rows);
      setResults.push({ setId, className, setName: setData.name, slots: rows.length });
    }

    if (!allRows.length) {
      return c.json({ ok: false, error: 'No tier item rows produced. Check that set IDs are correct.', errors });
    }

    await setTierItems(db, seasonId, allRows);

    return c.json({
      ok:      true,
      total:   allRows.length,
      sets:    setResults,
      errors,  // non-fatal per-set errors
      seasonId,
    });
  } catch (err) {
    console.error('[admin-items] tier-items/sync error:', err);
    return c.json({ error: err.message }, 500);
  }
});

export { router as itemDbRouter, tierRouter as tierItemsRouter };
