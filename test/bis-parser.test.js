/**
 * bis-parser.test.js — pure parsing + Item-DB resolution of BIS guide pages.
 * Fixtures mirror real shapes: Wowhead BBCode (toggle sections, [item=]/[skill=],
 * paired "A & B" weapon cells, inlined name JSON) and Maxroll names-only tables.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBisHtml, parseBisDocument, resolveBisItems, bisGuideUrl, splitSpecClass, normalizeName,
} from '../src/lib/bis-parser.js';

// ── URL builders ─────────────────────────────────────────────────────────────
test('bis-parser URLs', async (t) => {
  await t.test('splitSpecClass separates the trailing class', () => {
    assert.deepEqual(splitSpecClass('Frost Death Knight'), { spec: 'Frost', cls: 'Death Knight' });
    assert.deepEqual(splitSpecClass('Beast Mastery Hunter'), { spec: 'Beast Mastery', cls: 'Hunter' });
  });
  await t.test('source URLs derive from the canonical spec', () => {
    assert.equal(bisGuideUrl('Frost Death Knight', 'Wowhead'),
      'https://www.wowhead.com/guide/classes/death-knight/frost/bis-gear');
    assert.equal(bisGuideUrl('Frost Death Knight', 'Maxroll'),
      'https://maxroll.gg/wow/class-guides/frost-death-knight-raid-guide');
    assert.equal(bisGuideUrl('Frost Death Knight', 'Icy Veins'), ''); // dropped source
  });
});

// ── Wowhead BBCode parsing ──────────────────────────────────────────────────────
// Inlined name JSON + an "Overall" toggle (preferred over a "Preseason" decoy),
// a tier-annotated Head, a [skill=] crafted Chest, and a paired weapon cell.
const WOWHEAD_HTML = `
<script>{"258574":{"name_enus":"Skyforged Helm"},"258046":{"name_enus":"Choker of Doom"},`
+ `"258100":{"name_enus":"Cloak of Night"},"258200":{"name_enus":"Bands of Fury"},`
+ `"258400":{"name_enus":"Blade of Ruin"},"258500":{"name_enus":"Shield of Dawn"}}</script>
[toggle title="Preseason"]
[table][tr][th]Slot[/th][th]Item[/th][/tr]
[tr][td]Head[/td][td][item=999001][/td][/tr]
[tr][td]Neck[/td][td][item=999002][/td][/tr]
[tr][td]Back[/td][td][item=999003][/td][/tr]
[tr][td]Wrists[/td][td][item=999004][/td][/tr]
[tr][td]Chest[/td][td][item=999005][/td][/tr]
[/table]
[/toggle]
[toggle title="Overall"]
[table]
[tr][th]Slot[/th][th]Item[/th][th]Source[/th][/tr]
[tr][td]Head[/td][td][item=258574][/td][td]Tier[/td][/tr]
[tr][td]Neck[/td][td][item=258046][/td][td]Manaforge Omega[/td][/tr]
[tr][td]Back[/td][td][item=258100][/td][td]Manaforge Omega[/td][/tr]
[tr][td]Wrists[/td][td][item=258200][/td][td]Mythic+[/td][/tr]
[tr][td]Chest[/td][td][skill=165][/td][td]Leatherworking[/td][/tr]
[tr][td]Weapon[/td][td][item=258400][/td][td]Manaforge Omega[/td][/tr]
[tr][td]Off Hand[/td][td][item=258500][/td][td]Manaforge Omega[/td][/tr]
[/table]
[/toggle]
`;

test('Wowhead BBCode parse', async (t) => {
  const parsed = parseBisHtml(WOWHEAD_HTML, 'Wowhead');
  const bySlot = Object.fromEntries(parsed.map(p => [p.slot, p]));

  await t.test('uses the Overall toggle, not Preseason', () => {
    assert.equal(bySlot.Neck.itemId, '258046');            // Overall id, not 999002
    assert.ok(!parsed.some(p => p.itemId === '999002'));    // no Preseason leakage
  });
  await t.test('tier annotation on a tier slot → <Tier> (id cleared)', () => {
    assert.equal(bySlot.Head.itemName, '<Tier>');
    assert.equal(bySlot.Head.itemId, null);
  });
  await t.test('embedded name JSON resolves link text', () => {
    assert.equal(bySlot.Neck.itemName, 'Choker of Doom');
  });
  await t.test('[skill=] crafted marker → <Crafted>', () => {
    assert.equal(bySlot.Chest.itemName, '<Crafted>');
  });
  await t.test('separate Weapon and Off-Hand rows both parse', () => {
    assert.equal(bySlot.Weapon.itemName, 'Blade of Ruin');
    assert.equal(bySlot.Weapon.itemId, '258400');
    assert.equal(bySlot['Off-Hand'].itemName, 'Shield of Dawn');
    assert.equal(bySlot['Off-Hand'].itemId, '258500');
  });
});

// ── Maxroll paired "A & B" cell (plain text + data-wow-item) ─────────────────────
const MAXROLL_PAIRED_HTML = `
<table><tr><th>Slot</th><th>Item</th></tr>
<tr><td>Head</td><td><span data-wow-item="258574">Skyforged Helm</span></td></tr>
<tr><td>Neck</td><td><span data-wow-item="258046">Choker of Doom</span></td></tr>
<tr><td>Back</td><td><span data-wow-item="258100">Cloak of Night</span></td></tr>
<tr><td>Wrists</td><td><span data-wow-item="258200">Bands of Fury</span></td></tr>
<tr><td>Weapon</td><td><span data-wow-item="258400">Blade of Ruin</span> &amp; <span data-wow-item="258500">Shield of Dawn</span></td></tr>
</table>`;

test('Maxroll paired weapon cell splits into Weapon + Off-Hand', () => {
  const parsed = parseBisHtml(MAXROLL_PAIRED_HTML, 'Maxroll');
  const bySlot = Object.fromEntries(parsed.map(p => [p.slot, p]));
  assert.equal(bySlot.Weapon.itemName, 'Blade of Ruin');
  assert.equal(bySlot.Weapon.itemId, '258400');
  assert.equal(bySlot['Off-Hand'].itemName, 'Shield of Dawn');
  assert.equal(bySlot['Off-Hand'].itemId, '258500');
});

// ── Maxroll names-only parsing ───────────────────────────────────────────────────
const MAXROLL_HTML = `
<table>
<thead><tr><th>Slot</th><th>Best in Slot</th></tr></thead>
<tbody>
<tr><td>Head</td><td>Skyforged Helm</td></tr>
<tr><td>Neck</td><td>Choker of Doom</td></tr>
<tr><td>Shoulders</td><td>Mantle of Embers</td></tr>
<tr><td>Back</td><td>Cloak of Night</td></tr>
<tr><td>Chest</td><td>Breastplate of Valor</td></tr>
</tbody>
</table>`;

test('Maxroll names-only parse', async (t) => {
  const parsed = parseBisHtml(MAXROLL_HTML, 'Maxroll');
  await t.test('detects slots by name with null item IDs', () => {
    assert.equal(parsed.length, 5);
    assert.equal(parsed[0].slot, 'Head');
    assert.equal(parsed[0].itemName, 'Skyforged Helm');
    assert.equal(parsed[0].itemId, null);
  });
});

// ── Item-DB resolution + Raid BIS inference ─────────────────────────────────────
const ITEM_DB = [
  { item_id: '258574', name: 'Skyforged Helm', slot: 'Head',  source_type: 'Mythic+', armor_type: 'Plate' },
  { item_id: '258046', name: 'Choker of Doom', slot: 'Neck',  source_type: 'Raid',    armor_type: 'Accessory' },
  { item_id: '259000', name: "Relentless Rider's Helm", slot: 'Head', source_type: 'Raid', armor_type: 'Plate' },
];

test('resolveBisItems', async (t) => {
  await t.test('known ID present in DB → name canonicalised, status ok', () => {
    const [r] = resolveBisItems([{ slot: 'Head', itemName: 'wrong name', itemId: '258574' }], ITEM_DB);
    assert.equal(r.trueBis, 'Skyforged Helm');
    assert.equal(r.trueBisItemId, '258574');
    assert.equal(r.status, 'ok');
  });

  await t.test('known ID absent from DB → status unmatched, guide name kept', () => {
    const [r] = resolveBisItems([{ slot: 'Head', itemName: 'Mystery Helm', itemId: '777777' }], ITEM_DB);
    assert.equal(r.trueBis, 'Mystery Helm');
    assert.equal(r.status, 'unmatched');
  });

  await t.test('linked ID absent but the name matches → falls back to our DB ID (Krick case)', () => {
    // Guide links the RARE 133491; our DB has the same-named EPIC drop under 258574.
    const db = [{ item_id: '258574', name: "Krick's Beetle Stabber", slot: 'Weapon', source_type: 'Mythic+', armor_type: 'Accessory' }];
    const [r] = resolveBisItems([{ slot: 'Weapon', itemName: "Krick's Beetle Stabber", itemId: '133491' }], db);
    assert.equal(r.status, 'ok');
    assert.equal(r.trueBisItemId, '258574');   // adopted our DB's ID, not the guide's 133491
    assert.equal(r.trueBis, "Krick's Beetle Stabber");
  });

  await t.test('numeric placeholder name with no DB match → NOT FOUND', () => {
    const [r] = resolveBisItems([{ slot: 'Head', itemName: '888888', itemId: null }], ITEM_DB);
    assert.equal(r.trueBis, 'NOT FOUND');
    assert.equal(r.trueBisItemId, '888888');
    assert.equal(r.status, 'not_found');
  });

  await t.test('name-only (Maxroll) resolves to an ID', () => {
    const [r] = resolveBisItems([{ slot: 'Head', itemName: 'Skyforged Helm', itemId: null }], ITEM_DB);
    assert.equal(r.trueBisItemId, '258574');
    assert.equal(r.status, 'ok');
  });

  await t.test('name-only with no DB match → unmatched', () => {
    const [r] = resolveBisItems([{ slot: 'Feet', itemName: 'Boots of Mystery', itemId: null }], ITEM_DB);
    assert.equal(r.status, 'unmatched');
    assert.equal(r.trueBisItemId, '');
  });

  await t.test('raid-sourced Overall BIS seeds Raid BIS = Overall', () => {
    const [r] = resolveBisItems([{ slot: 'Neck', itemName: 'Choker of Doom', itemId: '258046' }], ITEM_DB);
    assert.equal(r.raidBis, 'Choker of Doom');
    assert.equal(r.raidBisItemId, '258046');
  });

  await t.test('mythic+ Overall BIS does NOT seed Raid BIS', () => {
    const [r] = resolveBisItems([{ slot: 'Head', itemName: 'Skyforged Helm', itemId: '258574' }], ITEM_DB);
    assert.equal(r.raidBis, '');
  });

  await t.test('known tier-set item ID → <Tier> even when not in the Item DB', () => {
    // "Voidbreaker's Robe" (tier chest) isn't a journal drop, so it's absent from item_db,
    // but its ID is in the season's tier_items → promote to <Tier> by slot.
    const [r] = resolveBisItems(
      [{ slot: 'Chest', itemName: "Voidbreaker's Robe", itemId: '300100' }],
      ITEM_DB,
      { tierItemIds: ['300100', '300200'] },
    );
    assert.equal(r.trueBis, '<Tier>');
    assert.equal(r.trueBisItemId, '');
    assert.equal(r.status, 'sentinel');
    assert.equal(r.raidBis, '<Tier>');
  });

  await t.test('tier-set name prefix on a tier slot → <Tier>, and is its own Raid BIS', () => {
    const [r] = resolveBisItems(
      [{ slot: 'Head', itemName: "Relentless Rider's Helm", itemId: '259000' }],
      ITEM_DB,
      { tierSetPrefixes: ["Relentless Rider's"] },
    );
    assert.equal(r.trueBis, '<Tier>');
    assert.equal(r.trueBisItemId, '');
    assert.equal(r.status, 'sentinel');
    assert.equal(r.raidBis, '<Tier>');
  });

  await t.test('curly apostrophe in the guide name still matches an ASCII-apostrophe DB name (#1)', () => {
    // ITEM_DB stores "Relentless Rider's Helm" with an ASCII '. The guide uses U+2019.
    // Disable prefix promotion so this isolates the name-normalisation match.
    const [r] = resolveBisItems(
      [{ slot: 'Head', itemName: 'Relentless Rider’s Helm', itemId: null }],
      ITEM_DB,
      { tierSetPrefixes: [] },
    );
    assert.equal(r.status, 'ok');
    assert.equal(r.trueBisItemId, '259000');
  });

  await t.test('normalizeName folds curly apostrophes and whitespace', () => {
    assert.equal(normalizeName('Voidbreaker’s  Robe'), normalizeName("Voidbreaker's Robe"));
    assert.equal(normalizeName('  Light’s March  '), "light's march");
  });

  await t.test('<Crafted> sentinel passes through, not a Raid BIS', () => {
    const [r] = resolveBisItems([{ slot: 'Chest', itemName: '<Crafted>', itemId: null }], ITEM_DB);
    assert.equal(r.trueBis, '<Crafted>');
    assert.equal(r.status, 'sentinel');
    assert.equal(r.raidBis, '');
  });

  await t.test('end-to-end: Wowhead parse → resolve', () => {
    const rows = resolveBisItems(parseBisHtml(WOWHEAD_HTML, 'Wowhead'), ITEM_DB);
    const neck = rows.find(r => r.slot === 'Neck');
    assert.equal(neck.trueBis, 'Choker of Doom');
    assert.equal(neck.raidBis, 'Choker of Doom');  // raid-sourced → inferred
    const head = rows.find(r => r.slot === 'Head');
    assert.equal(head.trueBis, '<Tier>');
  });
});

// ── #2: narrowed sentinel scan (no false positives from prose columns) ───────────
const NOTES_TABLE = `
<table><tr><th>Slot</th><th>Item</th><th>Notes</th></tr>
<tr><td>Head (Tier)</td><td>Whatever Helm</td><td></td></tr>
<tr><td>Neck</td><td>Choker of Doom</td><td>A great pickup to use until you complete your tier set bonus this catalyst patch</td></tr>
<tr><td>Back</td><td>Cloak of Night</td><td></td></tr>
<tr><td>Chest</td><td>Breastplate of Valor</td><td></td></tr>
<tr><td>Wrists</td><td>Bands of Fury</td><td></td></tr>
</table>`;

test('sentinel detection ignores long prose columns (#2)', () => {
  const bySlot = Object.fromEntries(parseBisHtml(NOTES_TABLE, 'Maxroll').map(p => [p.slot, p]));
  assert.equal(bySlot.Head.itemName, '<Tier>');          // slot parenthetical → still detected
  assert.equal(bySlot.Neck.itemName, 'Choker of Doom');  // "tier"/"catalyst" in a long note → NOT a sentinel
});

// Leading-keyword rule: long-but-genuine annotations match; mid-sentence prose doesn't.
const ANNOTATION_TABLE = `
<table><tr><th>Slot</th><th>Item</th><th>Source</th></tr>
<tr><td>Legs</td><td>Some Legguards</td><td>Tier Set (Catalyze Sporefall if possible)</td></tr>
<tr><td>Head</td><td>Some Helm</td><td>Tier Set</td></tr>
<tr><td>Neck</td><td>Choker</td><td>A good pickup to use until you finish your tier set bonus</td></tr>
<tr><td>Back</td><td>Cloak</td><td>Forgeweaver Araz (Catalyze it!)</td></tr>
<tr><td>Wrists</td><td>Bands</td><td>Manaforge Omega</td></tr>
</table>`;

test('leading/parenthetical keyword beats the length cap and prose (#2 refined)', () => {
  const bySlot = Object.fromEntries(parseBisHtml(ANNOTATION_TABLE, 'Maxroll').map(p => [p.slot, p]));
  assert.equal(bySlot.Legs.itemName, '<Tier>');       // 41-char source, leads with "Tier"
  assert.equal(bySlot.Head.itemName, '<Tier>');       // "Tier Set"
  assert.equal(bySlot.Neck.itemName, 'Choker');       // "tier" mid-sentence prose → not a sentinel
  assert.equal(bySlot.Back.itemName, '<Catalyst>');   // parenthetical "(Catalyze it!)" on a catalyst slot
  assert.equal(bySlot.Wrists.itemName, 'Bands');      // plain boss source
});

// Pipe-separated acquisition lists: "Raid | Catalyst | Vault". Catalyst as a mid-list
// chip must be detected, and on a tier slot it folds to <Tier>.
const PIPE_SOURCE_TABLE = `
<table><tr><th>Slot</th><th>Item</th><th>Source</th></tr>
<tr><td>Shoulders</td><td>Beacons of the Black Talon</td><td>Raid | Catalyst | Vault</td></tr>
<tr><td>Chest</td><td>Frenzyward of the Black Talon</td><td>Raid | Catalyst | Vault</td></tr>
<tr><td>Neck</td><td>Choker</td><td>Raid | Catalyst | Vault</td></tr>
<tr><td>Back</td><td>Fluxweave Cloak</td><td>Nexus Point Xenas</td></tr>
<tr><td>Wrists</td><td>Bands</td><td>Manaforge Omega</td></tr>
</table>`;

test('"Raid | Catalyst | Vault" → catalyst chip detected; tier slot folds to <Tier>', () => {
  const bySlot = Object.fromEntries(parseBisHtml(PIPE_SOURCE_TABLE, 'Maxroll').map(p => [p.slot, p]));
  assert.equal(bySlot.Shoulders.itemName, '<Tier>');     // catalyst on a tier slot → <Tier>
  assert.equal(bySlot.Chest.itemName, '<Tier>');
  assert.equal(bySlot.Neck.itemName, '<Catalyst>');      // catalyst on a non-tier armor slot
  assert.equal(bySlot.Back.itemName, 'Fluxweave Cloak'); // no keyword in the source
  assert.equal(bySlot.Wrists.itemName, 'Bands');
});

// Keyword inside a parenthetical but not right after "(" — "Rotmire (The Catalyst)".
const PAREN_SOURCE_TABLE = `
<table><tr><th>Slot</th><th>Item</th><th>Source</th></tr>
<tr><td>Legs</td><td>Greaves of the Black Talon</td><td>Rotmire (The Catalyst)</td></tr>
<tr><td>Feet</td><td>Spelltreads of the Black Talon</td><td>Rotmire (The Catalyst)</td></tr>
<tr><td>Neck</td><td>Choker</td><td>Rotmire (The Catalyst)</td></tr>
<tr><td>Back</td><td>Cloak</td><td>Nexus Point Xenas</td></tr>
<tr><td>Wrists</td><td>Bands</td><td>Manaforge Omega</td></tr>
</table>`;

test('"Boss (The Catalyst)" — keyword inside a paren is detected; tier slot → <Tier>', () => {
  const bySlot = Object.fromEntries(parseBisHtml(PAREN_SOURCE_TABLE, 'Maxroll').map(p => [p.slot, p]));
  assert.equal(bySlot.Legs.itemName, '<Tier>');       // catalyst on a tier slot → <Tier>
  assert.equal(bySlot.Feet.itemName, '<Catalyst>');   // catalyst on a non-tier armor slot
  assert.equal(bySlot.Neck.itemName, '<Catalyst>');
  assert.equal(bySlot.Back.itemName, 'Cloak');        // no keyword
});

// Maxroll: space-separated trailing keyword in a short cell — "Rotmire Catalyst".
const SHORT_SPACE_TABLE = `
<table><tr><th>Slot</th><th>Item</th><th>Source</th></tr>
<tr><td>Chest</td><td>Abyssal Immolator's Dreadrobe</td><td>Rotmire Catalyst</td></tr>
<tr><td>Feet</td><td>Some Boots</td><td>Rotmire Catalyst</td></tr>
<tr><td>Neck</td><td>Choker</td><td>Manaforge Omega</td></tr>
<tr><td>Back</td><td>Cloak</td><td>Nexus Point Xenas</td></tr>
<tr><td>Wrists</td><td>Bands</td><td>Ailindra</td></tr>
</table>`;

test('Maxroll "Rotmire Catalyst" (short, trailing keyword) detected; tier slot → <Tier>', () => {
  const bySlot = Object.fromEntries(parseBisHtml(SHORT_SPACE_TABLE, 'Maxroll').map(p => [p.slot, p]));
  assert.equal(bySlot.Chest.itemName, '<Tier>');      // catalyst on a tier slot → <Tier>
  assert.equal(bySlot.Feet.itemName, '<Catalyst>');   // non-tier armor slot
  assert.equal(bySlot.Neck.itemName, 'Choker');       // plain boss source, no keyword
});

// ── Crafted source encoded as [url guide=…]Crafting[/url] (real Wowhead shape) ────
// Uses escaped closing tags ([\/td]) exactly as Wowhead's page source stores them.
const WOWHEAD_URLSRC_HTML =
  `<script>{"258046":{"name_enus":"Choker of Doom"},"258100":{"name_enus":"Cloak of Night"},`
  + `"239660":{"name_enus":"Arcanoweave Bracers"},"258300":{"name_enus":"Breastplate of Valor"},`
  + `"258400":{"name_enus":"Blade of Ruin"}}</script>`
  + `[table][tr][th]Slot[/th][th]Item[/th][th]Source[/th][/tr]`
  + `[tr][td]Neck[\\/td][td][item=258046][\\/td][td][url guide=1]Manaforge Omega[\\/url][\\/td][\\/tr]`
  + `[tr][td]Back[\\/td][td][item=258100][\\/td][td]Manaforge Omega[\\/td][\\/tr]`
  + `[tr][td]Wrist[\\/td][td][item=239660 bonus=12806][\\/td][td][url guide=15942]Crafting[\\/url][\\/td][\\/tr]`
  + `[tr][td]Chest[\\/td][td][item=258300][\\/td][td]Manaforge Omega[\\/td][\\/tr]`
  + `[tr][td]Weapon[\\/td][td][item=258400][\\/td][td]Manaforge Omega[\\/td][\\/tr]`
  + `[\\/table]`;

test('Wowhead [url guide=…]Crafting[/url] source → <Crafted>', () => {
  const bySlot = Object.fromEntries(parseBisHtml(WOWHEAD_URLSRC_HTML, 'Wowhead').map(p => [p.slot, p]));
  assert.equal(bySlot.Wrists.itemName, '<Crafted>');          // detected via unwrapped [url] text
  assert.equal(bySlot.Neck.itemName, 'Choker of Doom');       // [url]-wrapped boss source doesn't interfere
  assert.equal(bySlot.Back.itemName, 'Cloak of Night');
});

// An [icon …] tag before the "Catalyst" url must not hide the annotation (real shape).
const WOWHEAD_ICON_CATALYST =
  `<script>{"250011":{"name_enus":"Strikeguards of Ra-den's Chosen"},"258046":{"name_enus":"Choker of Doom"},`
  + `"258100":{"name_enus":"Cloak of Night"},"258300":{"name_enus":"Breastplate of Valor"},`
  + `"258400":{"name_enus":"Blade of Ruin"}}</script>`
  + `[table][tr][th]Slot[/th][th]Item[/th][th]Source[/th][/tr]`
  + `[tr][td]Wrist[\\/td][td][color=q4][item=250011 bonus=12806:13335][\\/color][\\/td][td][icon name=inv_trinket_80_titan01a color=c10 inline=true type=round][\\/icon][url guide=33219]Catalyst[\\/url][\\/td][\\/tr]`
  + `[tr][td]Neck[\\/td][td][item=258046][\\/td][td]Manaforge Omega[\\/td][\\/tr]`
  + `[tr][td]Back[\\/td][td][item=258100][\\/td][td]Manaforge Omega[\\/td][\\/tr]`
  + `[tr][td]Chest[\\/td][td][item=258300][\\/td][td]Manaforge Omega[\\/td][\\/tr]`
  + `[tr][td]Weapon[\\/td][td][item=258400][\\/td][td]Manaforge Omega[\\/td][\\/tr]`
  + `[\\/table]`;

test('Wowhead [icon …] before [url]Catalyst → <Catalyst> (tag does not hide it)', () => {
  const bySlot = Object.fromEntries(parseBisHtml(WOWHEAD_ICON_CATALYST, 'Wowhead').map(p => [p.slot, p]));
  assert.equal(bySlot.Wrists.itemName, '<Catalyst>');
  assert.equal(bySlot.Neck.itemName, 'Choker of Doom');   // unaffected
});

// A decorative icon-only enchant column between Slot and Item must not shift parsing.
const WOWHEAD_ENCHANT_COL =
  `<script>{"249287":{"name_enus":"Arator's Swift Remembrance"},"258046":{"name_enus":"Choker of Doom"},`
  + `"258100":{"name_enus":"Cloak of Night"},"258300":{"name_enus":"Breastplate of Valor"},`
  + `"258400":{"name_enus":"Blade of Ruin"}}</script>`
  + `[table][tr][th]Slot[/th][th]Enchant[/th][th]Item[/th][th]Source[/th][/tr]`
  + `[tr][td][b]Main Hand[\\/b][\\/td][td][url=item=244029][icon name=inv_12_profession_enchanting inline=true][\\/icon][\\/url][\\/td][td][color=q4][item=249287 bonus=12806:13335][\\/color][\\/td][td][url guide=33226][icon name=inv_120_raid_voidspire][\\/icon] Vaelgor & Ezzorak[\\/url][\\/td][\\/tr]`
  + `[tr][td]Neck[\\/td][td][\\/td][td][item=258046][\\/td][td]Manaforge Omega[\\/td][\\/tr]`
  + `[tr][td]Back[\\/td][td][\\/td][td][item=258100][\\/td][td]Manaforge Omega[\\/td][\\/tr]`
  + `[tr][td]Chest[\\/td][td][\\/td][td][item=258300][\\/td][td]Manaforge Omega[\\/td][\\/tr]`
  + `[tr][td]Wrist[\\/td][td][\\/td][td][item=258400][\\/td][td]Manaforge Omega[\\/td][\\/tr]`
  + `[\\/table]`;

test('Wowhead decorative enchant column does not shift the item out of place', () => {
  const bySlot = Object.fromEntries(parseBisHtml(WOWHEAD_ENCHANT_COL, 'Wowhead').map(p => [p.slot, p]));
  assert.equal(bySlot.Weapon.itemId, '249287');                       // Main Hand → Weapon
  assert.equal(bySlot.Weapon.itemName, "Arator's Swift Remembrance"); // not the enchant, not empty
  assert.equal(bySlot.Neck.itemName, 'Choker of Doom');
});

// ── #3/#4/#5: parse diagnostics surfaced via parseBisDocument ────────────────────
test('parseBisDocument exposes diagnostics', async (t) => {
  await t.test('Overall toggle: no fallback, name JSON counted', () => {
    const { rows, meta } = parseBisDocument(WOWHEAD_HTML, 'Wowhead');
    assert.ok(rows.length >= 5);
    assert.equal(meta.usedBBCode, true);
    assert.equal(meta.toggleTitleUsed, 'Overall');
    assert.ok(!meta.toggleFellBack);
    assert.equal(meta.nameJsonCount, 6);
    assert.ok(meta.tablesSeen >= 1);
    assert.ok(meta.chosenRowCount >= 5);
  });

  await t.test('falls back when no "Overall" section, flags it (#5)', () => {
    const html =
      `<script>{"258574":{"name_enus":"Skyforged Helm"},"258046":{"name_enus":"Choker of Doom"},`
      + `"258100":{"name_enus":"Cloak of Night"},"258200":{"name_enus":"Bands of Fury"},`
      + `"258300":{"name_enus":"Breastplate of Valor"}}</script>`
      + `[toggle title="Single Target"]`
      + `[table][tr][th]Slot[/th][th]Item[/th][/tr]`
      + `[tr][td]Head[/td][td][item=258574][/td][/tr]`
      + `[tr][td]Neck[/td][td][item=258046][/td][/tr]`
      + `[tr][td]Back[/td][td][item=258100][/td][/tr]`
      + `[tr][td]Wrists[/td][td][item=258200][/td][/tr]`
      + `[tr][td]Chest[/td][td][item=258300][/td][/tr]`
      + `[/table][/toggle]`;
    const { rows, meta } = parseBisDocument(html, 'Wowhead');
    assert.ok(rows.length >= 5);
    assert.equal(meta.toggleFellBack, true);
    assert.equal(meta.toggleTitleUsed, 'Single Target');
  });

  await t.test('escaped quotes in name JSON are captured & unescaped (#3 robustness)', () => {
    const html =
      `<script>{"258700":{"name_enus":"Gaze of the \\"Eternal\\""},"258046":{"name_enus":"Choker of Doom"},`
      + `"258100":{"name_enus":"Cloak of Night"},"258200":{"name_enus":"Bands of Fury"},`
      + `"258300":{"name_enus":"Breastplate of Valor"}}</script>`
      + `[table][tr][th]Slot[/th][th]Item[/th][/tr]`
      + `[tr][td]Neck[/td][td][item=258700][/td][/tr]`
      + `[tr][td]Back[/td][td][item=258100][/td][/tr]`
      + `[tr][td]Wrists[/td][td][item=258200][/td][/tr]`
      + `[tr][td]Chest[/td][td][item=258300][/td][/tr]`
      + `[tr][td]Feet[/td][td][item=258046][/td][/tr]`
      + `[/table]`;
    const bySlot = Object.fromEntries(parseBisHtml(html, 'Wowhead').map(p => [p.slot, p]));
    assert.equal(bySlot.Neck.itemName, 'Gaze of the "Eternal"');  // not garbled / truncated
  });

  await t.test('no table → rejects explain why (#4)', () => {
    const { rows, meta } = parseBisDocument('<table><tr><td>nope</td></tr></table>', 'Maxroll');
    assert.equal(rows.length, 0);
    assert.ok(meta.rejects.length >= 1);
  });
});
