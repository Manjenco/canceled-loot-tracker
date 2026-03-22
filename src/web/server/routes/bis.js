/**
 * bis.js — Raider BIS submission routes.
 *
 * GET  /api/bis                      — load BIS slots for a spec
 * POST /api/bis                      — save BIS updates for a spec
 * POST /api/bis/request-spec-change  — request promotion of a secondary spec to primary
 */

import { Hono } from 'hono';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getBisSubmissions, getItemDb, getEffectiveDefaultBis, applyRaidBisInference,
  batchUpsertBisSubmissions, clearPendingBisSubmission, clearRejectedBisSubmission,
  clearBisSubmission, resetBisRaidBisField,
  getRoster, setPendingPrimarySpec,
} from '../../../lib/sheets.js';
import { toCanonical, getArmorType, canUseWeapon, canDualWield, CLASS_SPECS, getCharSpecs } from '../../../lib/specs.js';

const ALL_SLOTS = [
  'Head', 'Neck', 'Shoulders', 'Back', 'Chest', 'Wrists',
  'Hands', 'Waist', 'Legs', 'Feet',
  'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2', 'Weapon', 'Off-Hand',
];

const TIER_SLOTS     = new Set(['Head', 'Shoulders', 'Chest', 'Hands', 'Legs']);
const CATALYST_SLOTS = new Set(['Neck', 'Back', 'Wrists', 'Waist', 'Feet']);
const DIFF_ORDER     = { Mythic: 0, Heroic: 1, Normal: 2, 'Mythic+': 3 };

function itemOptionsForSlot(itemDb, slot, armorType, { raidOnly = false, canonSpec = '' } = {}) {
  let dbSlot = slot.replace(/ [12]$/, '');
  // Dual-wield specs equip a weapon in the off-hand, not a shield/frill.
  // Redirect the lookup to 'Weapon' so they see 1H/2H weapon options.
  if (dbSlot === 'Off-Hand' && canonSpec && canDualWield(canonSpec)) dbSlot = 'Weapon';
  return itemDb
    .filter(item => {
      if (item.slot !== dbSlot)   return false;
      if (item.isTierToken)       return false;
      if (raidOnly && item.sourceType !== 'Raid') return false;
      if (item.armorType === 'Accessory') {
        if (item.weaponType && canonSpec) return canUseWeapon(canonSpec, item.weaponType);
        return true;
      }
      return item.armorType === armorType;
    })
    .map(item => ({
      itemId:     String(item.itemId),
      name:       item.name,
      difficulty: item.difficulty ?? '',
      source:     item.sourceName ?? '',
      sourceType: item.sourceType ?? '',
    }))
    .sort((a, b) => {
      const da = DIFF_ORDER[a.difficulty] ?? 9;
      const db = DIFF_ORDER[b.difficulty] ?? 9;
      return da !== db ? da - db : a.name.localeCompare(b.name);
    });
}

const router = new Hono();
router.use('*', requireAuth);

// ── GET /api/bis ───────────────────────────────────────────────────────────────

router.get('/', async (c) => {
  const { teamSheetId, charId, charName } = c.get('session').user;
  if (!teamSheetId) return c.json({ noTeam: true });

  try {
    const [roster, submissions, itemDb, effectiveBis] = await Promise.all([
      getRoster(teamSheetId),
      getBisSubmissions(teamSheetId),
      getItemDb(),
      getEffectiveDefaultBis(),
    ]);

    // Resolve character and their available specs
    const rosterEntry = roster.find(r =>
      charId && r.charId ? r.charId === charId : r.charName.toLowerCase() === charName.toLowerCase()
    );
    const charSpecs = rosterEntry ? getCharSpecs(rosterEntry) : { primary: c.get('session').user.spec, secondary: [], pending: null, all: [c.get('session').user.spec] };

    // Determine which spec to show — ?spec= param or primary
    const requestedSpec = c.req.query('spec') || charSpecs.primary;
    if (!charSpecs.all.includes(requestedSpec)) {
      return c.json({ error: `Spec "${requestedSpec}" is not available for this character` }, 400);
    }
    const activeSpec    = requestedSpec;
    const canonicalSpec = toCanonical(activeSpec);
    const armorType     = getArmorType(canonicalSpec);

    const bySlot = Object.fromEntries(
      submissions
        .filter(s => {
          const charMatch = charId && s.charId ? s.charId === charId : s.charName.toLowerCase() === charName.toLowerCase();
          const specMatch = s.spec ? s.spec.toLowerCase() === activeSpec.toLowerCase() : true; // legacy fallback
          return charMatch && specMatch;
        })
        .map(s => [s.slot, s])
    );

    const specRows      = effectiveBis.filter(d => d.spec === canonicalSpec);
    const specDefaults  = applyRaidBisInference(specRows, itemDb);
    const defaultBySlot = Object.fromEntries(specDefaults.map(d => [d.slot, d]));

    const slots = ALL_SLOTS.map(slot => {
      const sub = bySlot[slot] ?? null;
      const def = defaultBySlot[slot] ?? null;

      const lastApproved = sub?.lastApprovedTrueBis
        ? {
            trueBis:       sub.lastApprovedTrueBis,
            raidBis:       sub.lastApprovedRaidBis,
            trueBisItemId: sub.lastApprovedTrueBisItemId,
            raidBisItemId: sub.lastApprovedRaidBisItemId,
          }
        : null;

      return {
        slot,
        submission:  sub,
        lastApproved,
        specDefault: def ? {
          trueBis:       def.trueBis       ?? '',
          trueBisItemId: def.trueBisItemId ?? '',
          raidBis:       def.raidBis       ?? '',
          raidBisItemId: def.raidBisItemId ?? '',
        } : null,
        sentinels: {
          tier:     TIER_SLOTS.has(slot),
          catalyst: CATALYST_SLOTS.has(slot),
          crafted:  true,
        },
        overallOptions: itemOptionsForSlot(itemDb, slot, armorType, { canonSpec: canonicalSpec }),
        raidOptions:    itemOptionsForSlot(itemDb, slot, armorType, { raidOnly: true, canonSpec: canonicalSpec }),
      };
    });

    return c.json({
      charName,
      spec:           activeSpec,
      availableSpecs: charSpecs.all.map(s => ({ spec: s, isPrimary: s === charSpecs.primary })),
      pendingSpecChange: charSpecs.pending,
      slots,
    });
  } catch (err) {
    console.error('[BIS] GET error:', err);
    return c.json({ error: 'Failed to load BIS data' }, 500);
  }
});

// ── POST /api/bis ──────────────────────────────────────────────────────────────

router.post('/', async (c) => {
  const body = await c.req.json();
  const { updates, spec: bodySpec } = body;
  if (!Array.isArray(updates) || !updates.length) {
    return c.json({ error: 'updates[] is required' }, 400);
  }

  const { teamSheetId, charId, charName } = c.get('session').user;
  if (!teamSheetId) return c.json({ error: 'No team configured' }, 400);
  if (!charName)    return c.json({ error: 'No character linked to this account' }, 400);

  // Determine active spec — from request body (multi-spec) or session fallback
  const roster      = await getRoster(teamSheetId);
  const rosterEntry = roster.find(r => charId && r.charId ? r.charId === charId : r.charName.toLowerCase() === charName.toLowerCase());
  const charSpecs   = rosterEntry ? getCharSpecs(rosterEntry) : { primary: c.get('session').user.spec, secondary: [], all: [c.get('session').user.spec] };
  const spec        = bodySpec && charSpecs.all.includes(bodySpec) ? bodySpec : charSpecs.primary;

  const validSlots = new Set(ALL_SLOTS);

  const validUpdates = updates.filter(u =>
    validSlots.has(u.slot) && (u.clearPending || u.clearRejected || u.clearSlot || u.resetRaidBis || u.trueBis)
  );

  if (!validUpdates.length) {
    return c.json({ error: 'No valid updates provided (slot required, trueBis required)' }, 400);
  }

  try {
    let saved   = 0;
    let cleared = 0;

    for (const u of validUpdates.filter(u => u.clearRejected)) {
      await clearRejectedBisSubmission(teamSheetId, charId, u.slot, charName);
      cleared++;
    }
    for (const u of validUpdates.filter(u => u.clearPending)) {
      await clearPendingBisSubmission(teamSheetId, charId, u.slot, charName);
      cleared++;
    }
    for (const u of validUpdates.filter(u => u.clearSlot)) {
      await clearBisSubmission(teamSheetId, charId, u.slot, charName);
      cleared++;
    }
    for (const u of validUpdates.filter(u => u.resetRaidBis)) {
      await resetBisRaidBisField(teamSheetId, charId, u.slot, charName);
      cleared++;
    }

    const saveUpdates = validUpdates.filter(u => !u.clearPending && !u.clearRejected && !u.clearSlot && !u.resetRaidBis);
    if (saveUpdates.length) {
      await batchUpsertBisSubmissions(teamSheetId, saveUpdates.map(u => ({
        charId,
        charName,
        spec,
        slot:          u.slot,
        trueBis:       u.trueBis,
        trueBisItemId: u.trueBisItemId ?? '',
        raidBis:       u.raidBis       ?? '',
        raidBisItemId: u.raidBisItemId ?? '',
        rationale:     u.rationale     ?? '',
      })));
      saved = saveUpdates.length;
    }

    const parts = [];
    if (saved)   parts.push(`${saved} slot${saved   !== 1 ? 's' : ''} saved`);
    if (cleared) parts.push(`${cleared} slot${cleared !== 1 ? 's' : ''} cleared`);
    return c.json({ ok: true, saved, cleared, message: parts.join(', ') });
  } catch (err) {
    console.error('[BIS] POST error:', err);
    return c.json({ error: 'Failed to save BIS submissions' }, 500);
  }
});

// ── POST /api/bis/request-spec-change ─────────────────────────────────────────
// Raider requests that one of their secondary specs becomes primary.
// Requires officer approval via /api/admin/bis-review/spec-change.

router.post('/request-spec-change', async (c) => {
  const { teamSheetId, charId, charName } = c.get('session').user;
  if (!teamSheetId) return c.json({ error: 'No team configured' }, 400);
  if (!charName)    return c.json({ error: 'No character linked to this account' }, 400);

  const { newPrimarySpec } = await c.req.json();
  if (!newPrimarySpec) return c.json({ error: 'newPrimarySpec is required' }, 400);

  try {
    const roster      = await getRoster(teamSheetId);
    const rosterEntry = roster.find(r => charId && r.charId ? r.charId === charId : r.charName.toLowerCase() === charName.toLowerCase());
    if (!rosterEntry) return c.json({ error: 'Character not found in roster' }, 404);

    const charSpecs = getCharSpecs(rosterEntry);

    // Can only promote an existing secondary spec
    if (!charSpecs.secondary.includes(newPrimarySpec)) {
      return c.json({ error: `"${newPrimarySpec}" is not a secondary spec for this character` }, 400);
    }
    // Reject if a change is already pending
    if (charSpecs.pending) {
      return c.json({ error: `A spec change to "${charSpecs.pending}" is already pending officer approval` }, 409);
    }

    await setPendingPrimarySpec(teamSheetId, rosterEntry.charId, newPrimarySpec);
    return c.json({ ok: true, pending: newPrimarySpec });
  } catch (err) {
    console.error('[BIS] request-spec-change error:', err);
    return c.json({ error: 'Failed to submit spec change request' }, 500);
  }
});

export default router;
