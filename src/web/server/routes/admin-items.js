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
import {
  getGlobalConfig, writeItemDb, setTierItems, getTierItems, getItemDb, getCurrentSeasonId, getSeasons,
  getSeasonSources, addSeasonSource, removeSeasonSource, setSeasonSourceEnabled,
  getDefaultBisItemRefs, deleteItemDbItems,
} from '../../../lib/db.js';
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

// ── Manifest diff helpers ─────────────────────────────────────────────────────

/**
 * Fetch + map + dedupe the "desired" item set from every ENABLED manifest source.
 * Returns { desired, perSource, errors }. A source that fails is recorded in errors
 * (never throws for a single source) — callers use errors.length to gate removals.
 */
async function fetchManifestDesired(db, env, seasonId) {
  const sources = (await getSeasonSources(db, seasonId)).filter(s => s.enabled);
  const creds   = await getBlizzardCreds(db, env);
  const perSource = [];
  const errors    = [];
  const items     = [];
  for (const src of sources) {
    try {
      const raw    = await fetchRaidItems(Number(src.source_id), src.difficulty, creds);
      const mapped = raw.map(mapItem).filter(Boolean);
      items.push(...mapped);
      perSource.push({ id: src.id, label: src.label || String(src.source_id), difficulty: src.difficulty, fetched: mapped.length });
    } catch (err) {
      errors.push(`${src.label || src.source_id} (${src.difficulty}): ${err.message}`);
    }
  }
  const seen    = new Set();
  const desired = items.filter(i => (seen.has(i.itemId) ? false : (seen.add(i.itemId), true)));
  return { sources, desired, perSource, errors };
}

const DIFF_FIELDS = [
  ['name',          d => d.name,                       r => r.name],
  ['slot',          d => d.slot,                       r => r.slot],
  ['source_type',   d => d.sourceType,                 r => r.source_type],
  ['source_name',   d => d.sourceName,                 r => r.source_name],
  ['instance',      d => d.instance,                   r => r.instance],
  ['difficulty',    d => d.difficulty,                 r => r.difficulty],
  ['armor_type',    d => d.armorType,                  r => r.armor_type],
  ['is_tier_token', d => (d.isTierToken ? 1 : 0),      r => r.is_tier_token],
];

/** Compare desired (mapItem output) vs current (item_db rows). Keyed on Blizzard item_id. */
function diffItems(desired, current) {
  const curById = new Map(current.map(r => [String(r.item_id), r]));
  const desById = new Map(desired.map(i => [String(i.itemId), i]));

  const added = [];
  const changed = [];
  for (const d of desired) {
    const cur = curById.get(String(d.itemId));
    if (!cur) { added.push(d); continue; }
    const fields = DIFF_FIELDS.filter(([, dv, cv]) => String(dv(d)) !== String(cv(cur))).map(([f]) => f);
    if (fields.length) {
      const oldVals = {};
      for (const [f, , cv] of DIFF_FIELDS) if (fields.includes(f)) oldVals[f] = cv(cur);
      changed.push({ ...d, changedFields: fields, old: oldVals });
    }
  }
  const removed = current.filter(r => !desById.has(String(r.item_id)));
  return { added, changed, removed };
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

// ── Source manifest ───────────────────────────────────────────────────────────
// The persisted set of Blizzard journal instances that define a season's item
// pool. Re-pulling from these (sync-manifest) keeps the Item DB in sync — additive
// only for now; the diff/apply flow with removals comes in a later phase.

const VALID_DIFFICULTIES = ['MYTHIC', 'HEROIC', 'NORMAL', 'LOOKING_FOR_RAID', 'MYTHIC_KEYSTONE'];

router.get('/sources', async (c) => {
  const db = c.env.DB;
  try {
    const seasonId = await resolveSeasonId(db, c.req.query('seasonId'));
    const sources = await getSeasonSources(db, seasonId);
    return c.json({ seasonId, sources });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

router.post('/sources', async (c) => {
  const db = c.env.DB;
  const { seasonId: reqSeason, sourceType = 'raid', sourceId, difficulty = 'MYTHIC', label = '' } = await c.req.json();
  if (!sourceId) return c.json({ error: 'sourceId is required' }, 400);
  if (!VALID_DIFFICULTIES.includes(difficulty)) {
    return c.json({ error: `difficulty must be one of: ${VALID_DIFFICULTIES.join(', ')}` }, 400);
  }
  try {
    const seasonId = await resolveSeasonId(db, reqSeason);
    await addSeasonSource(db, seasonId, { sourceType, sourceId, difficulty, label });
    return c.json({ ok: true, seasonId });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

router.patch('/sources/:id', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ error: 'Invalid source id' }, 400);
  const { seasonId: reqSeason, enabled } = await c.req.json();
  if (typeof enabled !== 'boolean') return c.json({ error: 'enabled (boolean) is required' }, 400);
  try {
    const seasonId = await resolveSeasonId(db, reqSeason);
    await setSeasonSourceEnabled(db, seasonId, id, enabled);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

router.delete('/sources/:id', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ error: 'Invalid source id' }, 400);
  try {
    const seasonId = await resolveSeasonId(db, c.req.query('seasonId'));
    await removeSeasonSource(db, seasonId, id);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /sync-manifest ───────────────────────────────────────────────────────
// Additively re-pulls every ENABLED source and upserts the union into item_db. No
// removals (use /diff + /apply for those). A failing source is reported, not fatal.

router.post('/sync-manifest', async (c) => {
  const db = c.env.DB;
  const { seasonId: reqSeason } = await c.req.json().catch(() => ({}));
  try {
    const seasonId = await resolveSeasonId(db, reqSeason);
    const { perSource, desired, errors } = await fetchManifestDesired(db, c.env, seasonId);
    if (!perSource.length && !errors.length) {
      return c.json({ error: 'No enabled sources in this season’s manifest.' }, 400);
    }
    if (desired.length) await writeItemDb(db, desired, seasonId, { replace: false });
    return c.json({ ok: true, seasonId, total: desired.length, sources: perSource, errors });
  } catch (err) {
    console.error('[admin-items] sync-manifest error:', err);
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /diff ────────────────────────────────────────────────────────────────
// Dry run: re-pull the manifest and compute added / changed / removed vs the
// season's current item_db. No writes. Removals are only *offered* when the season
// is not the live one AND every source fetched cleanly (partial pulls never remove).

router.post('/diff', async (c) => {
  const db = c.env.DB;
  const { seasonId: reqSeason } = await c.req.json().catch(() => ({}));
  try {
    const seasonId        = await resolveSeasonId(db, reqSeason);
    const currentSeasonId = await getCurrentSeasonId(db);
    const isCurrent       = seasonId === currentSeasonId;

    const { perSource, desired, errors } = await fetchManifestDesired(db, c.env, seasonId);
    if (!perSource.length && !errors.length) {
      return c.json({ error: 'No enabled sources in this season’s manifest.' }, 400);
    }

    const current = await getItemDb(db, seasonId);
    const { added, changed, removed } = diffItems(desired, current);

    const partial         = errors.length > 0;
    const removalsAllowed = !isCurrent && !partial;

    // Flag removed items that Default BIS hard-references (apply would block on these).
    const refPks   = await getDefaultBisItemRefs(db, seasonId);
    const removedA = removed.map(r => ({ ...r, referenced: refPks.has(r.id) }));

    return c.json({
      seasonId, isCurrent, partial, removalsAllowed,
      sourceErrors: errors, perSource,
      added, changed, removed: removedA,
      counts: { added: added.length, changed: changed.length, removed: removed.length },
    });
  } catch (err) {
    console.error('[admin-items] diff error:', err);
    return c.json({ error: err.message }, 500);
  }
});

// ── POST /apply ───────────────────────────────────────────────────────────────
// Apply selected buckets of the diff. Recomputes the diff server-side (never trusts
// a client-supplied item list) and applies only the requested buckets:
//   added/changed → upsert (UPDATE-in-place preserves item_db.id, so default_bis FKs survive)
//   removed       → hard delete, gated on non-live season + clean pull + no hard refs
// Body: { seasonId, buckets: ['added'|'changed'|'removed', ...] }

router.post('/apply', async (c) => {
  const db = c.env.DB;
  const { seasonId: reqSeason, buckets } = await c.req.json().catch(() => ({}));
  if (!Array.isArray(buckets) || !buckets.length) {
    return c.json({ error: 'buckets must be a non-empty array' }, 400);
  }
  const VALID = new Set(['added', 'changed', 'removed']);
  if (buckets.some(b => !VALID.has(b))) {
    return c.json({ error: "buckets may only contain 'added', 'changed', 'removed'" }, 400);
  }

  try {
    const seasonId        = await resolveSeasonId(db, reqSeason);
    const currentSeasonId = await getCurrentSeasonId(db);
    const isCurrent       = seasonId === currentSeasonId;

    const { desired, errors } = await fetchManifestDesired(db, c.env, seasonId);
    const partial = errors.length > 0;

    // Validate removal gating up front, before any write, so a mixed request can't
    // partially apply and then fail.
    if (buckets.includes('removed')) {
      if (isCurrent) return c.json({ error: 'Removals are not allowed on the current (live) season.' }, 400);
      if (partial)   return c.json({ error: 'Some sources failed to fetch — removals are blocked to avoid deleting from a partial pull.' }, 400);
    }

    const current = await getItemDb(db, seasonId);
    const { added, changed, removed } = diffItems(desired, current);

    const applied = { added: 0, changed: 0, removed: 0 };

    // added + changed → single additive upsert (changed updates in place by item_id).
    const toUpsert = [];
    if (buckets.includes('added'))   toUpsert.push(...added);
    if (buckets.includes('changed')) toUpsert.push(...changed);
    if (toUpsert.length) await writeItemDb(db, toUpsert, seasonId, { replace: false });
    if (buckets.includes('added'))   applied.added   = added.length;
    if (buckets.includes('changed')) applied.changed = changed.length;

    // removed → guarded hard delete (throws ITEM_REFERENCED if any is hard-referenced).
    if (buckets.includes('removed')) {
      const res = await deleteItemDbItems(db, seasonId, removed.map(r => r.item_id));
      applied.removed = res.deleted;
    }

    return c.json({ ok: true, seasonId, applied });
  } catch (err) {
    console.error('[admin-items] apply error:', err);
    const status = err.code === 'ITEM_REFERENCED' ? 409 : 500;
    return c.json({ error: err.message }, status);
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
