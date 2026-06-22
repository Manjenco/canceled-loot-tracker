/**
 * item-seeder.js — Item mapping logic for seeding item_db and tier_items.
 *
 * Shared between the Cloudflare Worker (admin API) and the CLI seed scripts.
 * No runtime dependencies — pure data transformation.
 */

// ── Slot mapping ──────────────────────────────────────────────────────────────

export const INVENTORY_SLOT = {
  HEAD:        'Head',
  NECK:        'Neck',
  SHOULDER:    'Shoulders',
  CHEST:       'Chest',
  ROBE:        'Chest',       // cloth chest pieces
  WAIST:       'Waist',
  LEGS:        'Legs',
  FEET:        'Feet',
  WRIST:       'Wrists',
  HAND:        'Hands',
  FINGER:      'Ring',
  TRINKET:     'Trinket',
  BACK:        'Back',
  CLOAK:       'Back',        // some back items use this type
  WEAPON:      'Weapon',
  RANGED:      'Weapon',
  RANGEDRIGHT: 'Weapon',      // wands / off-hand ranged
  TWO_HAND:    'Weapon',
  TWOHWEAPON:  'Weapon',      // alternate two-hand type string
  MAIN_HAND:   'Weapon',
  SHIELD:      'Off-Hand',
  OFF_HAND:    'Off-Hand',
  HOLDABLE:    'Off-Hand',    // held-in-off-hand (tomes, relics, etc.)
};

export const ARMOR_SUBCLASS = {
  1: 'Cloth',
  2: 'Leather',
  3: 'Mail',
  4: 'Plate',
};

export const ACCESSORY_SLOTS = new Set(['Neck', 'Back', 'Ring', 'Trinket', 'Weapon', 'Off-Hand']);

export const TIER_SLOTS = new Set(['Head', 'Shoulders', 'Chest', 'Hands', 'Legs']);

export const DIFFICULTY_LABEL = {
  MYTHIC:           'Mythic',
  HEROIC:           'Heroic',
  NORMAL:           'Normal',
  LOOKING_FOR_RAID: 'LFR',
  MYTHIC_KEYSTONE:  'Mythic+',
};

// Tier item slot map (used when seeding tier_items, not item_db)
export const TIER_ITEM_SLOT_MAP = {
  HEAD:     'Head',
  SHOULDER: 'Shoulders',
  CHEST:    'Chest',
  ROBE:     'Chest',
  HAND:     'Hands',
  LEGS:     'Legs',
};

// ── Tier token detection ───────────────────────────────────────────────────────
//
// A tier token is a NON_EQUIP item restricted to exactly one armor class-group (e.g.
// all three Cloth classes). That class-group IS the armor type — a robust, name-free
// signal Blizzard exposes as preview_item.requirements.playable_classes. So identifying
// tokens and their armor type needs NO per-expansion names.
//
// The SLOT, however, only lives in the token's flavor word (Midnight: Riftbloom=Chest,
// Fanatical=Head, …) and isn't cheaply derivable from game data (the token→piece
// conversion is an indirect player-choice spell). So slot stays a small per-expansion
// map — update TOKEN_SLOT_WORDS when a new expansion's tokens appear. A token that's
// recognised by class-group but whose slot is unknown is logged loudly and skipped,
// rather than silently vanishing.

const ARMOR_CLASS_GROUPS = {
  Cloth:   ['Mage', 'Priest', 'Warlock'],
  Leather: ['Demon Hunter', 'Druid', 'Monk', 'Rogue'],
  Mail:    ['Evoker', 'Hunter', 'Shaman'],
  Plate:   ['Death Knight', 'Paladin', 'Warrior'],
};
const ARMOR_BY_CLASS_KEY = new Map(
  Object.entries(ARMOR_CLASS_GROUPS).map(([armor, classes]) => [classes.slice().sort().join('|'), armor])
);

/** Armor type if `classNames` is exactly one armor class-group (a tier token), else null. */
function tierArmorFromClasses(classNames) {
  if (!classNames?.length) return null;
  const key = [...new Set(classNames)].sort().join('|');
  return ARMOR_BY_CLASS_KEY.get(key) ?? null;
}

/** Restricted class names from a Blizzard item detail (requirements.playable_classes). */
function playableClasses(details) {
  const pc = details?.preview_item?.requirements?.playable_classes;
  if (pc?.links?.length) return pc.links.map(l => l.name).filter(Boolean);
  const ds = pc?.display_string;
  if (!ds) return [];
  return ds.replace(/^Classes?:\s*/i, '').split(',').map(s => s.trim()).filter(Boolean);
}

// The one per-expansion touch: the token flavor word → slot. Matched as whole words.
const TOKEN_SLOT_WORDS = {
  Riftbloom: 'Chest', Fanatical: 'Head', Unraveled: 'Shoulders', Hungering: 'Hands', Corrupted: 'Legs', // Midnight
};
// Descriptive fallback for expansions that name tokens after gear types (stable).
const LEGACY_SLOT_KEYWORDS = [
  ['Head',      ['Helm', 'Helmet', 'Hood', 'Crown', 'Circlet', 'Cap', 'Headpiece']],
  ['Shoulders', ['Mantle', 'Spaulders', 'Pauldrons', 'Shoulderguards', 'Shoulderpads', 'Epaulets']],
  ['Chest',     ['Chestplate', 'Chestguard', 'Tunic', 'Robes', 'Robe', 'Vest', 'Hauberk', 'Breastplate', 'Jerkin', 'Coat']],
  ['Hands',     ['Gloves', 'Gauntlets', 'Handguards', 'Grips', 'Mitts']],
  ['Legs',      ['Leggings', 'Legplates', 'Breeches', 'Trousers', 'Greaves', 'Kilt']],
];

// Optional officer-supplied overrides, merged over TOKEN_SLOT_WORDS at runtime so a new
// expansion's token flavor words can be mapped from Global Config without a deploy. Set
// once per seed run from global_config.token_slot_overrides ("Word:Slot|Word:Slot").
let _tokenSlotOverrides = {};

/** Parse a "Word:Slot|Word:Slot" string into a { [word]: slot } map. */
export function parseTokenSlotOverrides(str) {
  const out = {};
  for (const pair of String(str ?? '').split('|')) {
    const [word, slot] = pair.split(':').map(s => s.trim());
    if (word && slot) out[word] = slot;
  }
  return out;
}

export function setTokenSlotOverrides(overrides) { _tokenSlotOverrides = overrides ?? {}; }

function tierTokenSlot(name) {
  const words = new Set(name.split(/\s+/).map(w => w.replace(/[''’]s$/i, '')));
  for (const [word, slot] of Object.entries(_tokenSlotOverrides)) if (words.has(word)) return slot; // override wins
  for (const [word, slot] of Object.entries(TOKEN_SLOT_WORDS))    if (words.has(word)) return slot;
  for (const [slot, keywords] of LEGACY_SLOT_KEYWORDS)            if (keywords.some(kw => name.includes(kw))) return slot;
  return null;
}

/**
 * If a Blizzard item detail is a tier token, return { slot, armorType }; else null.
 * Armor type is derived from the restricted class-group (robust); slot from the word
 * map above. A recognised token with an unknown slot is logged and returns null.
 */
export function tierTokenInfo(details) {
  if (details?.inventory_type?.type !== 'NON_EQUIP') return null;
  const armorType = tierArmorFromClasses(playableClasses(details));
  if (!armorType) return null; // not a tier token
  const slot = tierTokenSlot(details.name ?? '');
  if (!slot) {
    console.warn(`[item-seeder] Tier token "${details.name}" (#${details.id}) recognised (${armorType}) but slot unknown — add its word to TOKEN_SLOT_WORDS`);
    return null;
  }
  return { slot, armorType };
}

/**
 * Map a raw Blizzard fetchRaidItems result object to an item_db row.
 * Returns null for items that should be skipped (cosmetics, non-equip non-tokens, etc.).
 *
 * @param {{ details, encounterName, instanceName, difficulty }} raw
 * @returns {object|null}
 */
export function mapItem({ details, encounterName, instanceName, difficulty }) {
  const invTypeId = details.inventory_type?.type;
  let slot        = INVENTORY_SLOT[invTypeId];

  // NON_EQUIP: only keep recognised tier tokens (class-group identifies; word gives slot)
  if (!slot && invTypeId === 'NON_EQUIP') {
    const token = tierTokenInfo(details);
    if (!token) return null;
    return {
      itemId:      String(details.id),
      name:        details.name,
      slot:        token.slot,
      sourceType:  difficulty === 'MYTHIC_KEYSTONE' ? 'Mythic+' : 'Raid',
      sourceName:  encounterName,
      instance:    instanceName,
      difficulty:  DIFFICULTY_LABEL[difficulty] ?? difficulty,
      armorType:   token.armorType,
      isTierToken: true,
      weaponType:  '',
    };
  }

  if (!slot) return null;

  const isAccessory = ACCESSORY_SLOTS.has(slot);
  const armorSubId  = details.item_subclass?.id;
  const armorType   = isAccessory ? 'Accessory' : (ARMOR_SUBCLASS[armorSubId] ?? 'Accessory');
  const isTierToken = TIER_SLOTS.has(slot) && details.item_set != null;
  const weaponType  = (slot === 'Weapon' || slot === 'Off-Hand')
    ? (details.item_subclass?.name ?? '')
    : '';

  return {
    itemId:      String(details.id),
    name:        details.name,
    slot,
    sourceType:  difficulty === 'MYTHIC_KEYSTONE' ? 'Mythic+' : 'Raid',
    sourceName:  encounterName,
    instance:    instanceName,
    difficulty:  DIFFICULTY_LABEL[difficulty] ?? difficulty,
    armorType,
    isTierToken,
    weaponType,
  };
}
