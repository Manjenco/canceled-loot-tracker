/**
 * wago.js — read the game's DB2 journal tables from wago.tools to derive a
 * dungeon's CURRENT-season Mythic+ loot, which the Blizzard REST API can't
 * distinguish from legacy reuse.
 *
 * The discriminator (validated empirically): a JournalEncounterItem row is
 * current-season loot iff
 *     DifficultyMask == -1  AND  WorldStateExpressionID ∈ { 0, <season WSE> }
 * scoped to the dungeon's JournalEncounter rows. Old dungeons' original loot is
 * DifficultyMask=3 (dropped); a multi-season dungeon gates each season's set behind
 * a WorldStateExpression (e.g. Midnight S1 = 50188, its prior season = 50187); native
 * / recently-reused dungeons use WSE 0 (unconditional). NON_EQUIP junk is left for
 * mapItem() to drop downstream.
 *
 * The season WSE is a per-season constant (stored on seasons.mplus_wse), the same
 * shape as our other season config — see detectSeasonWse() to find it.
 */

const WAGO_BASE = 'https://wago.tools/db2';
const TTL_MS    = 60 * 60 * 1000; // tables change per game build; 1h is plenty for admin syncs
const _cache    = new Map();      // name → { rows, expiresAt }

/** Minimal RFC4180 CSV parser (handles quoted fields with commas/quotes). */
export function parseWagoCsv(text) {
  const lines = text.split(/\r?\n/);
  const cols  = splitCsvLine(lines[0] ?? '');
  const rows  = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const vals = splitCsvLine(lines[i]);
    const o = {};
    for (let j = 0; j < cols.length; j++) o[cols[j]] = vals[j];
    rows.push(o);
  }
  return rows;
}

function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Fetch + cache a DB2 table (latest build) as parsed rows. */
export async function fetchWagoTable(name, fetchImpl = fetch) {
  const hit = _cache.get(name);
  if (hit && Date.now() < hit.expiresAt) return hit.rows;
  const r = await fetchImpl(`${WAGO_BASE}/${encodeURIComponent(name)}/csv`);
  if (!r.ok) throw new Error(`wago.tools ${name}: HTTP ${r.status}`);
  const rows = parseWagoCsv(await r.text());
  _cache.set(name, { rows, expiresAt: Date.now() + TTL_MS });
  return rows;
}

/** Resolve a JournalInstance id by exact name (Name_lang). */
export function findInstanceId(instances, name) {
  return instances.find(r => r.Name_lang === name)?.ID ?? null;
}

/**
 * PURE — the current-season loot rule. Given parsed JournalEncounter and
 * JournalEncounterItem rows, return [{ itemId, encounterName }] for one dungeon.
 */
export function computeMplusItemPicks(encounters, encounterItems, instanceId, seasonWse) {
  const instId = String(instanceId);
  const encName = new Map();
  for (const e of encounters) {
    if (String(e.JournalInstanceID) === instId) encName.set(String(e.ID), e.Name_lang ?? '');
  }
  if (!encName.size) return [];

  const wse  = String(seasonWse ?? '');
  const seen = new Set();
  const out  = [];
  for (const it of encounterItems) {
    const encId = String(it.JournalEncounterID);
    if (!encName.has(encId)) continue;
    if (it.DifficultyMask !== '-1') continue;                              // drop old normal/heroic base loot
    const w = String(it.WorldStateExpressionID);
    if (w !== '0' && w !== wse) continue;                                  // drop other seasons' gated reuse
    const itemId = String(it.ItemID);
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    out.push({ itemId, encounterName: encName.get(encId) });
  }
  return out;
}

/**
 * PURE — suggest the current season WSE: the WorldStateExpressionID shared by the
 * most of a set of known in-rotation import instance ids (the season-gated dungeons).
 * Returns [{ wse, dungeonCount }] ranked, so the admin can confirm the top one.
 */
export function detectSeasonWse(encounters, encounterItems, importInstanceIds) {
  const wanted = new Set(importInstanceIds.map(String));
  const instByEnc = new Map();
  for (const e of encounters) instByEnc.set(String(e.ID), String(e.JournalInstanceID));
  const wseToInsts = new Map(); // wse → Set(instanceId)
  for (const it of encounterItems) {
    const w = String(it.WorldStateExpressionID);
    if (w === '0' || it.DifficultyMask !== '-1') continue;
    const inst = instByEnc.get(String(it.JournalEncounterID));
    if (!inst || !wanted.has(inst)) continue;
    if (!wseToInsts.has(w)) wseToInsts.set(w, new Set());
    wseToInsts.get(w).add(inst);
  }
  return [...wseToInsts.entries()]
    .map(([wse, insts]) => ({ wse: Number(wse), dungeonCount: insts.size }))
    .sort((a, b) => b.dungeonCount - a.dungeonCount);
}
