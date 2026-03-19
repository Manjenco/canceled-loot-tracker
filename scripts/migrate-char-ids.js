/**
 * migrate-char-ids.js — One-time migration to add stable character UUIDs
 * to existing sheet data.
 *
 * What this script does (non-destructive — only writes to new/empty cells):
 *
 *   1. Roster (col H) — generates a UUID for every row that doesn't have one.
 *      Existing cols A–G are untouched.
 *
 *   2. BIS Submissions (col N) — looks up each row's charName (col B) in the
 *      Roster to find its charId, then writes it to col N.
 *      Rows already having a charId in col N are skipped.
 *
 *   3. Loot Log (col K) — looks up each row's recipientChar (col H) in the
 *      Roster to find its charId, then writes it to col K.
 *      Rows already having a charId in col K are skipped.
 *
 * Usage:
 *   node --env-file=.env scripts/migrate-char-ids.js <teamSheetId>
 *
 * Run once per team sheet. Safe to re-run — skips already-migrated rows.
 *
 * Example (migrate your Mythic team):
 *   node --env-file=.env scripts/migrate-char-ids.js $TEAM_MYTHIC_SHEET_ID
 */

import { randomUUID } from 'node:crypto';
import { readRange, writeRange, batchWriteRanges } from '../src/lib/sheets.js';

// ── CLI arg ────────────────────────────────────────────────────────────────────

const sheetId = process.argv[2] ?? process.env.TEAM_MYTHIC_SHEET_ID;
if (!sheetId) {
  console.error('Usage: node --env-file=.env scripts/migrate-char-ids.js <teamSheetId>');
  process.exit(1);
}

console.log(`\n=== Migrating char IDs for sheet ${sheetId} ===\n`);

// ── Helper: batch write in chunks to avoid hitting the API limits ──────────────

async function batchWriteChunked(sheetId, updates, label, chunkSize = 50) {
  if (!updates.length) { console.log(`  ${label}: nothing to write`); return; }
  console.log(`  ${label}: writing ${updates.length} cells in chunks of ${chunkSize}…`);
  for (let i = 0; i < updates.length; i += chunkSize) {
    await batchWriteRanges(sheetId, updates.slice(i, i + chunkSize));
    process.stdout.write(`    chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(updates.length / chunkSize)} done\r`);
  }
  console.log(`  ${label}: ✓ ${updates.length} cells written                    `);
}

// ── Step 1: Roster — generate charId for every row missing one ────────────────

console.log('Step 1: Roster — generating charIds for un-migrated rows…');

// Schema (new): A=CharName B=Class C=Spec D=Role E=Status F=OwnerId G=OwnerNick H=CharId
const rosterRows = await readRange(sheetId, 'Roster!A2:H');

const charIdByName = new Map();  // charName.toLowerCase() → charId
const rosterUpdates = [];

for (let i = 0; i < rosterRows.length; i++) {
  const r        = rosterRows[i];
  const charName = String(r[0] ?? '').trim();
  const status   = String(r[4] ?? '').trim().toLowerCase();
  const existing = String(r[7] ?? '').trim(); // col H

  if (!charName || status === 'deleted') continue;

  if (existing) {
    // Already has a charId — just record it for downstream steps
    charIdByName.set(charName.toLowerCase(), existing);
    continue;
  }

  const charId = randomUUID();
  charIdByName.set(charName.toLowerCase(), charId);
  rosterUpdates.push({ range: `Roster!H${i + 2}`, values: [[charId]] });
}

await batchWriteChunked(sheetId, rosterUpdates, 'Roster!H (charId)');
console.log(`  Roster: ${charIdByName.size} characters mapped (${rosterUpdates.length} new IDs generated)\n`);

// ── Step 2: BIS Submissions — fill col N from charName lookup ─────────────────

console.log('Step 2: BIS Submissions — writing charId to col N…');

// Schema (new): A=Id B=CharName C=Spec D=Slot … M=RaidBISItemId N=CharId
const bisRows = await readRange(sheetId, 'BIS Submissions!A2:N');

const bisUpdates = [];
let bisMissing   = 0;

for (let i = 0; i < bisRows.length; i++) {
  const r        = bisRows[i];
  const id       = String(r[0]  ?? '').trim();
  const charName = String(r[1]  ?? '').trim();
  const existing = String(r[13] ?? '').trim(); // col N

  if (!id || !charName || existing) continue;  // blank row or already migrated

  const charId = charIdByName.get(charName.toLowerCase());
  if (!charId) {
    console.warn(`  ⚠  BIS row ${i + 2}: charName "${charName}" not found in roster — skipped`);
    bisMissing++;
    continue;
  }

  bisUpdates.push({ range: `BIS Submissions!N${i + 2}`, values: [[charId]] });
}

await batchWriteChunked(sheetId, bisUpdates, 'BIS Submissions!N (charId)');
if (bisMissing) console.warn(`  ⚠  ${bisMissing} BIS rows could not be linked (char not in roster)`);
console.log();

// ── Step 3: Loot Log — fill col K from recipientChar lookup ───────────────────

console.log('Step 3: Loot Log — writing recipientCharId to col K…');

// Schema (new): A=Id … H=RecipientChar … J=Notes K=RecipientCharId
const lootRows = await readRange(sheetId, 'Loot Log!A2:K');

const lootUpdates = [];
let lootMissing   = 0;

for (let i = 0; i < lootRows.length; i++) {
  const r             = lootRows[i];
  const id            = String(r[0]  ?? '').trim();
  const recipientChar = String(r[7]  ?? '').trim(); // col H
  const existing      = String(r[10] ?? '').trim(); // col K

  if (!id || !recipientChar || existing) continue;

  const charId = charIdByName.get(recipientChar.toLowerCase());
  if (!charId) {
    console.warn(`  ⚠  Loot row ${i + 2}: recipientChar "${recipientChar}" not found in roster — skipped`);
    lootMissing++;
    continue;
  }

  lootUpdates.push({ range: `Loot Log!K${i + 2}`, values: [[charId]] });
}

await batchWriteChunked(sheetId, lootUpdates, 'Loot Log!K (recipientCharId)');
if (lootMissing) console.warn(`  ⚠  ${lootMissing} loot rows could not be linked (char not in roster)`);
console.log();

// ── Done ──────────────────────────────────────────────────────────────────────

console.log('=== Migration complete ===');
console.log(`  Roster charIds written:     ${rosterUpdates.length}`);
console.log(`  BIS charIds written:        ${bisUpdates.length}`);
console.log(`  Loot log charIds written:   ${lootUpdates.length}`);
if (bisMissing || lootMissing) {
  console.warn(`\n  ⚠  Some rows were skipped because the character name in the linked data`);
  console.warn(`     does not match any active roster entry. These rows will fall back to`);
  console.warn(`     name-based joins until you resolve the discrepancy and re-run the script.`);
}
