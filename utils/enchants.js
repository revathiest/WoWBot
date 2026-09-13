// utils/enchants.js
// Which equipped slots are expected to carry an enchant, and whether they do.
//
// Getting this list right is the whole value of the audit. Naively reporting
// every slot without an enchant produces constant false positives: in TBC the
// neck, waist, trinkets, shirt and tabard cannot be enchanted at all, so they
// are permanently "missing" one.
//
// Sockets are deliberately not audited. Blizzard exposes gems that ARE socketed
// (as non-PERMANENT enchantment entries) but never exposes the socket list —
// `sockets` is absent from equipped items and null on the item document — so an
// empty socket is indistinguishable from no socket. Claiming otherwise would be
// guesswork.

// Always enchantable in TBC.
const ENCHANTABLE_SLOTS = [
  'HEAD',
  'SHOULDER',
  'BACK',
  'CHEST',
  'WRIST',
  'HANDS',
  'LEGS',
  'FEET',
  'MAIN_HAND'
];

// Enchanters only, so a missing one is worth noting but not a failure.
const OPTIONAL_SLOTS = ['FINGER_1', 'FINGER_2'];

// Off-hand counts only when it is a weapon or shield; held-in-off-hand items
// (tomes, orbs, idols) take no enchant.
const OFF_HAND_ENCHANTABLE = new Set([
  'ONE_HANDED_AXE',
  'ONE_HANDED_MACE',
  'ONE_HANDED_SWORD',
  'DAGGER',
  'FIST_WEAPON',
  'SHIELD'
]);

// Ranged takes a scope only if it actually fires something. Relics (idol,
// libram, totem) never do.
const RANGED_ENCHANTABLE = new Set(['BOW', 'GUN', 'CROSSBOW']);

function subclassOf(item) {
  return String(item?.item_subclass?.type ?? item?.item_subclass?.name ?? '')
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

/** True when this equipped item is expected to carry a permanent enchant. */
function expectsEnchant(item) {
  const slot = item?.slot?.type;
  if (!slot) return false;

  if (ENCHANTABLE_SLOTS.includes(slot)) return true;
  if (slot === 'OFF_HAND') return OFF_HAND_ENCHANTABLE.has(subclassOf(item));
  if (slot === 'RANGED') return RANGED_ENCHANTABLE.has(subclassOf(item));

  return false;
}

/** The permanent enchant on an item, if any. Gems use other slot types. */
function permanentEnchant(item) {
  return (item?.enchantments ?? []).find(
    enchantment => enchantment?.enchantment_slot?.type === 'PERMANENT'
  );
}

/** Gems and other non-permanent additions, for information rather than audit. */
function gems(item) {
  return (item?.enchantments ?? []).filter(
    enchantment => enchantment?.enchantment_slot?.type !== 'PERMANENT'
  );
}

/**
 * Audits a character's equipment.
 *
 * @returns {{ missing: object[], optional: object[], enchanted: object[], gemCount: number, checked: number }}
 */
function auditEquipment(equipment) {
  const items = equipment?.equipped_items ?? [];

  const missing = [];
  const optional = [];
  const enchanted = [];
  let gemCount = 0;
  let checked = 0;

  // Counted separately, because mixing enchanter-only rings into the headline
  // number makes a fully-enchanted character look incomplete and vice versa.
  let requiredTotal = 0;
  let requiredEnchanted = 0;
  let optionalEnchanted = 0;

  for (const item of items) {
    gemCount += gems(item).length;

    const slot = item?.slot?.type;
    const isOptional = OPTIONAL_SLOTS.includes(slot);

    if (!expectsEnchant(item) && !isOptional) continue;

    checked += 1;
    if (!isOptional) requiredTotal += 1;

    const enchant = permanentEnchant(item);

    if (enchant) {
      enchanted.push({ item, enchant, optional: isOptional });
      if (isOptional) optionalEnchanted += 1;
      else requiredEnchanted += 1;
    } else if (isOptional) {
      optional.push({ item });
    } else {
      missing.push({ item });
    }
  }

  return {
    missing,
    optional,
    enchanted,
    gemCount,
    checked,
    requiredTotal,
    requiredEnchanted,
    optionalEnchanted
  };
}

module.exports = {
  ENCHANTABLE_SLOTS,
  OFF_HAND_ENCHANTABLE,
  OPTIONAL_SLOTS,
  RANGED_ENCHANTABLE,
  auditEquipment,
  expectsEnchant,
  gems,
  permanentEnchant,
  subclassOf
};
