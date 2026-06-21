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
// Midnight uses two NON_EQUIP tier token families:
//   Nullcore  — Head/Shoulders/Hands/Legs
//   Riftbloom — Chest only
//
// Armor type is inferred from the suffix of the first word:
//   *forged → Plate   *cast → Mail   *cured → Leather   *woven → Cloth
//
// Legacy expansions used Conqueror/Protector/Vanquisher tokens — also supported.

const ARMOR_WORD_SUFFIX = {
  forged: 'Plate',
  cast:   'Mail',
  cured:  'Leather',
  woven:  'Cloth',
};

function armorTypeFromWord(word) {
  const lower = word.toLowerCase();
  for (const [suffix, type] of Object.entries(ARMOR_WORD_SUFFIX)) {
    if (lower.endsWith(suffix)) return type;
  }
  return null;
}

const NULLCORE_SLOT_WORD = {
  Fanatical: 'Head',
  Unraveled: 'Shoulders',
  Hungering: 'Hands',
  Corrupted: 'Legs',
};

const LEGACY_TOKEN_SUFFIXES = new Set(['Conqueror', 'Protector', 'Vanquisher']);
const LEGACY_SLOT_KEYWORDS  = [
  ['Head',      ['Helm', 'Helmet', 'Hood', 'Crown', 'Circlet', 'Cap', 'Headpiece']],
  ['Shoulders', ['Mantle', 'Spaulders', 'Pauldrons', 'Shoulderguards', 'Shoulderpads', 'Epaulets']],
  ['Chest',     ['Chestplate', 'Chestguard', 'Tunic', 'Robes', 'Robe', 'Vest', 'Hauberk', 'Breastplate', 'Jerkin', 'Coat']],
  ['Hands',     ['Gloves', 'Gauntlets', 'Handguards', 'Grips', 'Mitts']],
  ['Legs',      ['Leggings', 'Legplates', 'Breeches', 'Trousers', 'Greaves', 'Kilt']],
];

function isNullcore(name)    { return name.endsWith('Nullcore'); }
function isRiftbloom(name)   { return name.endsWith('Riftbloom'); }
function isLegacyToken(name) {
  return name.split(/\s+/).some(w => LEGACY_TOKEN_SUFFIXES.has(w.replace(/[''’]s$/i, '')));
}
function looksLikeTierToken(name) {
  return isNullcore(name) || isRiftbloom(name) || isLegacyToken(name);
}

/**
 * Infer { slot, armorType } for a tier token item name.
 * Returns null if the name is not a recognised tier token pattern.
 */
export function inferTierToken(name) {
  const words = name.split(/\s+/);

  if (isNullcore(name)) {
    const armorType = armorTypeFromWord(words[0]);
    const slot      = NULLCORE_SLOT_WORD[words[1]] ?? null;
    if (!slot) return null;
    return { slot, armorType: armorType ?? 'Tier Token' };
  }

  if (isRiftbloom(name)) {
    const armorType = armorTypeFromWord(words[0]);
    if (!armorType) return null;
    return { slot: 'Chest', armorType };
  }

  // Legacy Conqueror/Protector/Vanquisher
  for (const [slot, keywords] of LEGACY_SLOT_KEYWORDS) {
    if (keywords.some(kw => name.includes(kw))) return { slot, armorType: 'Tier Token' };
  }
  return null;
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

  // NON_EQUIP: only keep recognised tier tokens
  if (!slot && invTypeId === 'NON_EQUIP') {
    if (looksLikeTierToken(details.name)) {
      const tier = inferTierToken(details.name);
      if (tier) {
        return {
          itemId:      String(details.id),
          name:        details.name,
          slot:        tier.slot,
          sourceType:  difficulty === 'MYTHIC_KEYSTONE' ? 'Mythic+' : 'Raid',
          sourceName:  encounterName,
          instance:    instanceName,
          difficulty:  DIFFICULTY_LABEL[difficulty] ?? difficulty,
          armorType:   tier.armorType,
          isTierToken: true,
          weaponType:  '',
        };
      }
    }
    return null;
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
