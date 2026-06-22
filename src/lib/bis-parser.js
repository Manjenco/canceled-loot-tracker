/**
 * bis-parser.js — Pure, I/O-free parsing of public BIS guide pages.
 *
 * Ported from the (now-retired, Sheets-based) scripts/seed-default-bis.js so the
 * whole flow can run inside the web app. This module does NO network or DB work:
 *   • parseBisHtml(html, source)  → [{ slot, itemName, itemId }]   (raw parse)
 *   • resolveBisItems(parsed, itemDb, opts) → enriched rows ready for review/import
 *   • bisGuideUrl(canonicalSpec, source) → the guide URL to fetch (hand-verified per season)
 *
 * The Worker route fetches the HTML (or accepts pasted page source) and feeds it here.
 * Supported sources: 'Wowhead' (BBCode tables + embedded item JSON) and 'Maxroll'
 * (names-only, resolved against the Item DB).
 *
 * item_db rows are the D1 shape (snake_case): item_id, name, slot, source_type,
 * armor_type, is_tier_token, source_name, difficulty.
 */

// ── Canonical slots & sentinel rules ────────────────────────────────────────────

export const ALL_SLOTS = [
  'Head', 'Neck', 'Shoulders', 'Back', 'Chest', 'Wrists',
  'Hands', 'Waist', 'Legs', 'Feet',
  'Ring 1', 'Ring 2', 'Trinket 1', 'Trinket 2', 'Weapon', 'Off-Hand',
];

// Slots that carry a tier set piece — <Catalyst> is invalid here, always <Tier>.
export const TIER_SLOTS = new Set(['Head', 'Shoulders', 'Chest', 'Hands', 'Legs']);
// Non-tier armor slots where <Catalyst> is valid (accessory slots get neither).
export const CATALYST_SLOTS = new Set(['Neck', 'Back', 'Wrists', 'Waist', 'Feet']);

export const SENTINELS = new Set(['<Tier>', '<Catalyst>', '<Crafted>']);

/**
 * Tier-set item-name prefixes for the current tier. When a guide lists the actual
 * tier piece name (rather than annotating the row "Tier"), an item whose name starts
 * with one of these is promoted to <Tier> / <Catalyst> by slot.
 *
 * This is season-specific. Callers should pass the current list (e.g. from
 * global_config.bis_tier_set_prefixes) so it can be updated deploy-free; this
 * constant is only the built-in fallback.
 */
export const DEFAULT_TIER_SET_PREFIXES = [
  "Devouring Reaver's",   // Demon Hunter (Leather)
  "Luminant Verdict's",   // Paladin (Plate)
  "Relentless Rider's",   // Death Knight (Plate)
];

// Maps slot names found on guide pages → our canonical slot names. Ring / Trinket
// resolve to a base token here and are numbered (Ring 1/2 …) during table parsing.
const SLOT_ALIASES = {
  'Head': 'Head', 'Helm': 'Head', 'Helmet': 'Head',
  'Neck': 'Neck', 'Necklace': 'Neck', 'Amulet': 'Neck',
  'Shoulder': 'Shoulders', 'Shoulders': 'Shoulders', 'Mantle': 'Shoulders',
  'Spaulders': 'Shoulders', 'Epaulettes': 'Shoulders',
  'Back': 'Back', 'Cloak': 'Back', 'Cape': 'Back',
  'Chest': 'Chest', 'Robe': 'Chest', 'Tunic': 'Chest',
  'Breastplate': 'Chest', 'Chestplate': 'Chest', 'Chestguard': 'Chest',
  'Wrist': 'Wrists', 'Wrists': 'Wrists', 'Bracers': 'Wrists', 'Bracer': 'Wrists',
  'Hands': 'Hands', 'Hand': 'Hands', 'Gloves': 'Hands', 'Gauntlets': 'Hands',
  'Waist': 'Waist', 'Belt': 'Waist',
  'Legs': 'Legs', 'Leggings': 'Legs', 'Pants': 'Legs', 'Greaves': 'Legs',
  'Feet': 'Feet', 'Boots': 'Feet', 'Shoes': 'Feet', 'Sandals': 'Feet',
  'Ring': 'Ring', 'Ring 1': 'Ring', 'Ring 2': 'Ring',
  'Finger': 'Ring', 'Finger 1': 'Ring', 'Finger 2': 'Ring',
  'Trinket': 'Trinket', 'Trinkets': 'Trinket', 'Trinket 1': 'Trinket', 'Trinket 2': 'Trinket',
  'Weapon': 'Weapon', 'Weapons': 'Weapon', 'Weapon 1': 'Weapon',
  'Main Hand': 'Weapon', 'Main-Hand': 'Weapon', 'Mainhand': 'Weapon',
  'One-Hand': 'Weapon', 'One Hand': 'Weapon', '1H': 'Weapon', '1-Hand': 'Weapon',
  '1H Weapon': 'Weapon', '1h Weapon': 'Weapon', 'One-Hand Weapon': 'Weapon', 'One Hand Weapon': 'Weapon',
  'Two-Hand': 'Weapon', 'Two Hand': 'Weapon', '2H': 'Weapon', '2-Hand': 'Weapon',
  '2H Weapon': 'Weapon', '2h Weapon': 'Weapon',
  'Off Hand': 'Off-Hand', 'Off-Hand': 'Off-Hand', 'Offhand': 'Off-Hand',
  'Shield': 'Off-Hand', 'Off Hand Weapon': 'Off-Hand', 'Held In Off-Hand': 'Off-Hand',
  'Weapon 2': 'Off-Hand', 'Weapon Off-Hand': 'Off-Hand', 'Weapon Offhand': 'Off-Hand',
};

const CRAFTING_PROFESSIONS = [
  'Blacksmithing', 'Leatherworking', 'Tailoring', 'Jewelcrafting',
  'Engineering', 'Inscription', 'Alchemy',
];
const CRAFTED_RE = new RegExp(
  `\\bCraft(?:ed|ing)\\b|\\b(?:${CRAFTING_PROFESSIONS.join('|')})\\b`, 'i'
);

const COMPANION_SLOT = { 'Weapon': 'Off-Hand', 'Ring 1': 'Ring 2', 'Trinket 1': 'Trinket 2' };

// ── URL builders ────────────────────────────────────────────────────────────────
// Derived from the canonical spec name (e.g. "Frost Death Knight"). URLs are
// hand-verified per season; these are best-effort defaults the officer can edit.

const CLASSES = [
  'Death Knight', 'Demon Hunter', 'Druid', 'Evoker', 'Hunter', 'Mage', 'Monk',
  'Paladin', 'Priest', 'Rogue', 'Shaman', 'Warlock', 'Warrior',
];

/** Split a canonical "Spec Class" into { spec, cls } using the known class suffixes. */
export function splitSpecClass(canonicalSpec) {
  const cls = CLASSES.find(c => canonicalSpec.endsWith(c)) ?? '';
  const spec = cls ? canonicalSpec.slice(0, canonicalSpec.length - cls.length).trim() : canonicalSpec;
  return { spec, cls };
}

const slug = (s) => s.trim().toLowerCase().replace(/\s+/g, '-');

/** https://www.wowhead.com/guide/classes/death-knight/frost/bis-gear */
export function wowheadBisUrl(canonicalSpec) {
  const { spec, cls } = splitSpecClass(canonicalSpec);
  return `https://www.wowhead.com/guide/classes/${slug(cls)}/${slug(spec)}/bis-gear`;
}

/** https://maxroll.gg/wow/class-guides/frost-death-knight-raid-guide */
export function maxrollBisUrl(canonicalSpec) {
  return `https://maxroll.gg/wow/class-guides/${slug(canonicalSpec)}-raid-guide`;
}

/** Best-effort default guide URL for a source. Returns '' for unknown sources. */
export function bisGuideUrl(canonicalSpec, source) {
  if (source === 'Wowhead') return wowheadBisUrl(canonicalSpec);
  if (source === 'Maxroll')  return maxrollBisUrl(canonicalSpec);
  return '';
}

export const VALID_SOURCES = ['Wowhead', 'Maxroll'];

// ── HTML helpers ──────────────────────────────────────────────────────────────

/** Strip all HTML tags and collapse whitespace to a single space. */
function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Normalise an item name for matching against the Item DB. WoW names are full of
 * possessives ("Voidbreaker's", "Light's March"), and guide pages vs the Blizzard
 * API disagree on apostrophe encoding (curly ' U+2019 vs ASCII '), plus stray
 * NBSPs / double spaces. Without this, possessive items silently fail to match.
 * Returns a lowercased, punctuation-normalised key — NOT for display.
 */
export function normalizeName(str) {
  return String(str ?? '')
    .normalize('NFKC')
    .replace(/[‘’ʼ′´`]/g, "'")  // curly/modifier apostrophes → ASCII '
    .replace(/[“”″]/g, '"')               // curly double quotes → ASCII "
    .replace(/ /g, ' ')                             // non-breaking space → space
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Decode common HTML entities (numeric hex/dec and named). */
function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g,          (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Extract a wowhead item ID from a cell's HTML (full URL, relative link, or Maxroll data attr). */
function extractItemId(cellHtml) {
  let m = cellHtml.match(/wowhead\.com\/(?:[\w-]+\/)?item=(\d+)/);
  if (m) return m[1];
  m = cellHtml.match(/href=["'][^"']*[/?]item=(\d+)/);
  if (m) return m[1];
  m = cellHtml.match(/data-wow-item=["'](\d+)/);
  if (m) return m[1];
  return null;
}

/** Extract the display name from the first item link in a cell (falls back to plain text). */
function extractItemName(cellHtml) {
  let m = cellHtml.match(/href="[^"]*wowhead[^"]*"[^>]*>([^<]+)<\/a>/);
  if (m) return decodeEntities(m[1].trim());
  m = cellHtml.match(/href="[^"]*[/?]item=\d+[^"]*"[^>]*>([^<]+)<\/a>/);
  if (m) return decodeEntities(m[1].trim());
  const plain = decodeEntities(stripTags(cellHtml));
  return plain.length > 1 ? plain : null;
}

/** Normalise a raw slot cell to its base canonical token (Ring / Trinket not yet numbered). */
function normaliseSlot(rawCellHtml) {
  const text = stripTags(rawCellHtml).split(/[(\[]/)[0].trim();
  if (SLOT_ALIASES[text]) return SLOT_ALIASES[text];
  const lower = text.toLowerCase();
  for (const [alias, canonical] of Object.entries(SLOT_ALIASES)) {
    if (alias.toLowerCase() === lower) return canonical;
  }
  return null;
}

// ── Core table scanner ──────────────────────────────────────────────────────────

/**
 * Detect Tier / Catalyst / Crafted annotations for a row WITHOUT scanning long
 * prose columns. Tier/Catalyst are read only from the slot cell's parenthetical
 * (e.g. "Head (Tier)") and SHORT dedicated columns (≤24 chars, the annotation/source
 * column). Crafted additionally checks the item cell (which carries the BBCode
 * [skill=]→"Crafted" marker). This stops words like "tier"/"catalyst"/"craft" in a
 * notes/rationale column from false-triggering a sentinel.
 */
function detectSentinelFlags(cells, hasPairedItems) {
  // Annotation/source cells: the slot parenthetical and every column after the item.
  // Rather than length-capping them, the keyword must LEAD the cell or sit right after
  // an opening "(" — so genuine annotations ("Tier Set (Catalyze Sporefall…)",
  // "Crafting", "Catalyze it!", "Boss (Catalyze it!)") match, while a word buried
  // mid-sentence in a prose/notes column ("…good until you get your tier set") does not.
  const slotParen = (stripTags(cells[0] ?? '').match(/[([]([^)\]]*)[)\]]/) || ['', ''])[1];
  const annoCells = [slotParen];
  for (let i = 2; i < cells.length; i++) annoCells.push(decodeEntities(stripTags(cells[i] ?? '')).trim());
  // Crafted may also be flagged inside the item cell (BBCode [skill=]→"Crafted").
  const craftedCells = [...annoCells, decodeEntities(stripTags(cells[1] ?? '')).trim()];

  // Three ways a keyword counts as an annotation (not prose). A keyword buried
  // mid-sentence in a long prose/notes column matches none of them:
  //   • boundary — string start or after ( | / — its own chip: "Tier Set …",
  //     "Raid | Catalyst | Vault", "Boss (Catalyze it!)".
  //   • a whole word anywhere inside a parenthetical — "Rotmire (The Catalyst)".
  //   • a whole word anywhere in a SHORT cell — "Rotmire Catalyst" — i.e. a source/
  //     annotation column rather than a long sentence. (Long cells need the keyword
  //     set off via boundary/paren, which is what keeps prose out.)
  const ANNOTATION_MAX = 40;
  const BTIER  = /(?:^|[(|/])\s*tier\b/i;
  const BCATA  = /(?:^|[(|/])\s*cataly[sz]/i;
  const BCRAFT = new RegExp(`(?:^|[(|/])\\s*(?:craft(?:ed|ing)?|${CRAFTING_PROFESSIONS.join('|')})\\b`, 'i');
  const WTIER  = /\btier\b/i;
  const WCATA  = /\bcataly[sz]/i;
  const WCRAFT = new RegExp(`\\b(?:craft(?:ed|ing)?|${CRAFTING_PROFESSIONS.join('|')})\\b`, 'i');

  const parensOf = (t) => [...t.matchAll(/\(([^)]*)\)/g)].map(m => m[1]);
  const hit = (arr, boundaryRe, wordRe) =>
    arr.some(t =>
      boundaryRe.test(t) ||
      parensOf(t).some(p => wordRe.test(p)) ||
      (t.length <= ANNOTATION_MAX && wordRe.test(t))
    );

  const isTier     = hit(annoCells, BTIER, WTIER);
  const isCatalyst = !isTier && hit(annoCells, BCATA, WCATA);
  const isCrafted  = !isTier && !isCatalyst && !hasPairedItems && hit(craftedCells, BCRAFT, WCRAFT);
  return { isTier, isCatalyst, isCrafted };
}

/**
 * Shared table-scanning core. filterFn(tableHtml) → bool pre-screens each <table>.
 * Returns an array of { slot, itemName, itemId } objects, or [] if none found.
 * `meta` (optional) collects diagnostics: tablesSeen, rejects[], chosenRowCount.
 */
function scanBisTables(html, filterFn, meta = {}) {
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  const cellRe  = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const reject  = (reason) => { (meta.rejects ??= []).push(reason); };

  for (const tableMatch of html.matchAll(tableRe)) {
    const tableHtml = tableMatch[0];
    if (!filterFn(tableHtml)) continue;
    meta.tablesSeen = (meta.tablesSeen ?? 0) + 1;

    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const rows  = [...tableHtml.matchAll(rowRe)].map(m => m[1]);
    if (rows.length < 3) { reject('table had fewer than 3 rows'); continue; }

    const headerText = stripTags(rows[0]).toLowerCase();
    if (!headerText.includes('slot') && !headerText.includes('gear')) {
      reject('no "Slot"/"Gear" header column'); continue;
    }

    // Confirm at least 3 of the first 6 data rows have a recognised slot name
    let slotHits = 0;
    for (const row of rows.slice(1, 7)) {
      const cells = [...row.matchAll(cellRe)].map(m => m[1]);
      if (cells.length >= 2 && normaliseSlot(cells[0]) !== null) slotHits++;
    }
    if (slotHits < 3) { reject('too few recognised slot names in the first rows'); continue; }

    // ── This is our BIS table — parse it ──────────────────────────────────────
    const results    = [];
    const slotCounts = { Ring: 0, Trinket: 0 };
    const seenSlots  = new Set();

    for (const row of rows.slice(1)) {
      // Drop cells that are empty after tag-stripping. Some guides add a decorative
      // icon-only column (e.g. an enchant/embellishment) between Slot and Item; those
      // strip to nothing, so removing them realigns [Slot, (icon), Item, Source] back
      // to [Slot, Item, Source] and the item lands in cells[1] as expected.
      const cells = [...row.matchAll(cellRe)].map(m => m[1]).filter(c => stripTags(c).trim() !== '');
      if (cells.length < 2) continue;

      const base = normaliseSlot(cells[0]);
      if (!base) continue;

      let slot;
      if (base === 'Ring')         { slotCounts.Ring++;    slot = `Ring ${slotCounts.Ring}`; }
      else if (base === 'Trinket') { slotCounts.Trinket++; slot = `Trinket ${slotCounts.Trinket}`; }
      else                         { slot = base; }

      if (seenSlots.has(slot)) continue;
      seenSlots.add(slot);

      const itemCell       = cells[1];
      const hasPairedItems = /\s+&\s+/.test(decodeEntities(stripTags(itemCell)));
      const { isTier, isCatalyst, isCrafted } = detectSentinelFlags(cells, hasPairedItems);
      // Tier slots can only ever be <Tier>; a guide that says <Catalyst> there is wrong.
      const effectivelyTier = isTier || (isCatalyst && TIER_SLOTS.has(slot));

      let itemName, itemId;
      if (effectivelyTier)  { itemName = '<Tier>';     itemId = null; }
      else if (isCatalyst)  { itemName = '<Catalyst>'; itemId = null; }
      else if (isCrafted)   { itemName = '<Crafted>';  itemId = null; }
      else                  { itemName = extractItemName(itemCell); itemId = extractItemId(itemCell); }

      if (!itemName) continue;

      // Handle paired items listed as "Item A & Item B" in one cell.
      const nameParts = itemName.split(/\s+&\s+/);
      if (nameParts.length > 1 && COMPANION_SLOT[slot]) {
        const idRe   = /(?:data-wow-item=["'](\d+)[:"']|[/?]item=(\d+))/g;
        const allIds = [...itemCell.matchAll(idRe)].map(m => m[1] ?? m[2]);
        const sourceParts = cells[2]
          ? decodeEntities(stripTags(cells[2])).split(/\s+&\s+/)
          : [];
        const isPartCrafted = i =>
          CRAFTED_RE.test(nameParts[i] ?? '') ||
          CRAFTED_RE.test(sourceParts[i] ?? '');
        const name0 = isPartCrafted(0) ? '<Crafted>' : nameParts[0].trim();
        const id0   = name0 === '<Crafted>' ? null : (allIds[0] ?? itemId ?? null);
        results.push({ slot, itemName: name0, itemId: id0 });
        const companion = COMPANION_SLOT[slot];
        if (!seenSlots.has(companion)) {
          seenSlots.add(companion);
          const name1 = isPartCrafted(1) ? '<Crafted>' : nameParts[1].trim();
          const id1   = name1 === '<Crafted>' ? null : (allIds[1] ?? null);
          results.push({ slot: companion, itemName: name1, itemId: id1 });
        }
      } else {
        results.push({ slot, itemName, itemId });
      }
    }

    if (results.length >= 5) { meta.chosenRowCount = results.length; return results; }
    // Fewer than 5 results — probably not the BIS table, keep scanning.
    reject(`a candidate table yielded only ${results.length} item(s)`);
  }

  return [];
}

// ── Wowhead ───────────────────────────────────────────────────────────────────

/** Convert Wowhead BBCode (escaped or not) to HTML the scanner understands. */
function bbcodeToHtml(html) {
  return html
    .replace(/\[table[^\]]*\]/gi,  '<table>')
    .replace(/\[\\?\/table\]/gi,   '</table>')
    .replace(/\[tr[^\]]*\]/gi,     '<tr>')
    .replace(/\[\\?\/tr\]/gi,      '</tr>')
    .replace(/\[th[^\]]*\]/gi,     '<th>')
    .replace(/\[\\?\/th\]/gi,      '</th>')
    .replace(/\[td[^\]]*\]/gi,     '<td>')
    .replace(/\[\\?\/td\]/gi,      '</td>')
    .replace(/\[b\]/gi,  '<b>').replace(/\[\\?\/b\]/gi,  '</b>')
    .replace(/\[i\]/gi,  '<i>').replace(/\[\\?\/i\]/gi,  '</i>')
    .replace(/\[color=[^\]]*\]/gi, '').replace(/\[\\?\/color\]/gi, '')
    // [url guide=…]Text[/url] / [url=…]Text[/url] — unwrap, keep the inner text.
    // Source-column links (e.g. "Crafting", a boss guide) live in these; without
    // unwrapping, the [url …] wrapper hides the annotation word from detection.
    .replace(/\[url[^\]]*\]/gi, '').replace(/\[\\?\/url\]/gi, '')
    .replace(/\[item=(\d+)[^\]]*\]/gi, '<a href="/item=$1">$1</a>')
    // [skill=ID] — crafting profession source icon; render as literal "Crafted".
    .replace(/\[skill=[^\]]*\]/gi, 'Crafted')
    // Catch-all: strip any OTHER leftover BBCode tag markers (icon, spell, npc, quest,
    // …) while keeping their inner text. An unhandled tag like [icon name=… …] is long
    // and would inflate the cell, hiding the annotation word (e.g. "Catalyst") behind
    // it. Runs last so the specific conversions above win; HTML (<a …>) is untouched.
    .replace(/\[\\?\/?[a-z][^\]]*\]/gi, '');
}

/**
 * Extract only the "Overall" toggle section (skip Preseason etc.). Falls back to full
 * content. Records into meta which toggle title was used and whether it fell back to a
 * non-"Overall" section (so the caller can warn the officer to double-check).
 */
function extractWowheadOverallSection(raw, meta = {}) {
  const toggleRe = /\[toggle\b[^\]]*title="([^"]*)"[^\]]*\]([\s\S]*?)\[\\?\/toggle\]/gi;
  const blocks   = [...raw.matchAll(toggleRe)];
  if (blocks.length === 0) return raw;          // no toggles — whole content is one section
  const overall = blocks.find(b => /overall/i.test(b[1]));
  if (overall) { meta.toggleTitleUsed = overall[1]; return overall[2]; }
  const nonPreseason = blocks.find(b => !/pre.?season/i.test(b[1]));
  const chosen = nonPreseason ?? blocks[0];
  meta.toggleTitleUsed = chosen[1];
  meta.toggleFellBack  = true;                  // couldn't find an explicit "Overall" section
  return chosen[2];
}

/** Map of itemId → name from Wowhead's inlined item JSON ("ID":{"name_enus":"…"}). */
function extractWowheadItemNames(html) {
  const map = new Map();
  // name_enus may carry escaped quotes; capture lazily up to the closing unescaped quote.
  const re  = /"(\d{5,})"\s*:\s*\{[^}]*?"name_enus"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) map.set(m[1], m[2].replace(/\\(.)/g, '$1'));
  return map;
}

function parseWowheadBis(html, meta = {}) {
  const hasBBCode = /\[table\b|\[tr\]|\[td\b/i.test(html);
  meta.usedBBCode = hasBBCode;
  const raw = hasBBCode ? extractWowheadOverallSection(html, meta) : html;
  let src   = hasBBCode ? bbcodeToHtml(raw) : html;

  if (hasBBCode) {
    const names = extractWowheadItemNames(html);
    meta.nameJsonCount = names.size;
    if (names.size > 0) {
      src = src.replace(/<a href="\/item=(\d+)"[^>]*>(\d+)<\/a>/gi, (match, id) => {
        const name = names.get(id);
        return name ? `<a href="/item=${id}">${name}</a>` : match;
      });
    }
  }

  return scanBisTables(src, t => /[/?]item=\d+/.test(t), meta);
}

// ── Maxroll ─────────────────────────────────────────────────────────────────────
// Items link to Maxroll's own CDN, not Wowhead. Rely purely on slot-name detection;
// itemId may be null (names resolved against the Item DB later).
function parseMaxrollBis(html, meta = {}) {
  return scanBisTables(html, () => true, meta);
}

const SOURCE_PARSERS = {
  'Wowhead': parseWowheadBis,
  'Maxroll': parseMaxrollBis,
};

/**
 * Parse guide HTML for a source into raw rows plus diagnostics.
 * @returns {{ rows: Array<{slot,itemName,itemId}>, meta: object }}
 *   meta: { source, usedBBCode?, toggleTitleUsed?, toggleFellBack?, nameJsonCount?,
 *           tablesSeen?, rejects?: string[], chosenRowCount? }
 */
export function parseBisDocument(html, source) {
  const parser = SOURCE_PARSERS[source];
  if (!parser) throw new Error(`Unknown BIS source: ${source}`);
  const meta = { source, tablesSeen: 0, rejects: [] };
  const rows = parser(String(html ?? ''), meta);
  return { rows, meta };
}

/**
 * Parse guide HTML for a source into raw slot rows (rows only — see parseBisDocument
 * for diagnostics).
 * @returns {Array<{ slot, itemName, itemId }>}  empty if no BIS table found.
 */
export function parseBisHtml(html, source) {
  return parseBisDocument(html, source).rows;
}

// ── Item-DB resolution + Raid BIS inference ──────────────────────────────────────

/**
 * Resolve parsed rows against the Item DB and infer Raid BIS, producing rows ready
 * for the review screen and import. Pure — never touches the network or DB.
 *
 * Each output row:
 *   { slot, trueBis, trueBisItemId, raidBis, raidBisItemId, status }
 * where trueBisItemId / raidBisItemId are Blizzard item IDs (strings) or '' / a sentinel,
 * and status ∈ 'ok' | 'sentinel' | 'unmatched' | 'not_found':
 *   ok        — resolved to an Item DB entry (officer can accept as-is)
 *   sentinel  — <Tier> / <Catalyst> / <Crafted>
 *   unmatched — a real item name/ID, but not present in this season's Item DB (officer should verify)
 *   not_found — a numeric placeholder that resolved to nothing (guide ID unknown)
 *
 * @param {Array} parsed                   output of parseBisHtml
 * @param {Array} itemDb                   D1 item_db rows (snake_case fields)
 * @param {object} [opts]
 * @param {Iterable<string>} [opts.tierItemIds]  Blizzard IDs of this class's tier-set pieces
 *        (from the tier_items table) → exact-ID promotion to <Tier>/<Catalyst>. Most reliable.
 * @param {string[]} [opts.tierSetPrefixes]  current-tier name prefixes → promote to sentinels.
 *        Name-based fallback for sources without item IDs (e.g. Maxroll).
 */
export function resolveBisItems(parsed, itemDb, { tierSetPrefixes = DEFAULT_TIER_SET_PREFIXES, tierItemIds } = {}) {
  const byId   = new Map(itemDb.map(i => [String(i.item_id), i]));
  const byName = new Map(itemDb.map(i => [normalizeName(i.name), i]));
  const prefixesLower = tierSetPrefixes.map(p => normalizeName(p));
  const tierIds = tierItemIds instanceof Set ? tierItemIds : new Set([...(tierItemIds ?? [])].map(String));

  return parsed.map(p => {
    let trueBis       = p.itemName;
    let trueBisItemId = p.itemId ? String(p.itemId) : '';
    let status        = 'ok';
    let dbItem        = null;

    if (SENTINELS.has(trueBis)) {
      status = 'sentinel';
    } else if (trueBisItemId && /^\d+$/.test(trueBisItemId)) {
      // Pass 0: ID known (Maxroll data attr / Wowhead link) — canonicalise the name.
      dbItem = byId.get(trueBisItemId) ?? null;
      if (dbItem) {
        trueBis = dbItem.name;
      } else {
        // The linked ID isn't in this season's DB. Guides sometimes link an
        // alternate/legacy ID for a same-named item (e.g. a RARE catalog entry vs
        // the EPIC drop we seed). Fall back to a name match and adopt our DB's ID.
        const named = byName.get(normalizeName(trueBis));
        if (named) { dbItem = named; trueBisItemId = String(named.item_id); }
        else status = 'unmatched';
      }
    } else if (/^\d+$/.test(trueBis)) {
      // Pass 1: numeric placeholder name (Wowhead BBCode with no embedded name).
      trueBisItemId = trueBis;
      dbItem = byId.get(trueBisItemId) ?? null;
      if (dbItem) trueBis = dbItem.name;
      else { trueBis = 'NOT FOUND'; status = 'not_found'; }
    } else if (trueBis) {
      // Pass 2: name → ID lookup (Maxroll / any source without inline IDs).
      dbItem = byName.get(normalizeName(trueBis)) ?? null;
      if (dbItem) trueBisItemId = String(dbItem.item_id);
      else status = 'unmatched';
    }

    // Pass 3: promote known tier-set pieces to a sentinel by slot.
    //   3a — exact item-ID match against the season's tier_items (most reliable).
    //   3b — name-prefix fallback, for sources without item IDs (e.g. Maxroll).
    if (!SENTINELS.has(trueBis) && trueBis && trueBis !== 'NOT FOUND') {
      const idMatch   = trueBisItemId && tierIds.has(String(trueBisItemId));
      const nameMatch = prefixesLower.some(pre => normalizeName(trueBis).startsWith(pre));
      if (idMatch || nameMatch) {
        if (TIER_SLOTS.has(p.slot))          { trueBis = '<Tier>';     trueBisItemId = ''; status = 'sentinel'; dbItem = null; }
        else if (CATALYST_SLOTS.has(p.slot)) { trueBis = '<Catalyst>'; trueBisItemId = ''; status = 'sentinel'; dbItem = null; }
      }
    }

    // Raid BIS inference. <Tier>/<Catalyst> are themselves valid Raid BIS; <Crafted> is not.
    // A resolved raid-sourced item seeds Raid BIS = Overall BIS.
    let raidBis = '', raidBisItemId = '';
    if (trueBis === '<Tier>' || trueBis === '<Catalyst>') {
      raidBis = trueBis;
    } else if (dbItem?.source_type === 'Raid') {
      raidBis = trueBis;
      raidBisItemId = trueBisItemId;
    }

    return { slot: p.slot, trueBis, trueBisItemId, raidBis, raidBisItemId, status };
  });
}
