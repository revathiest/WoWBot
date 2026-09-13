const {
  auditEquipment,
  expectsEnchant,
  gems,
  permanentEnchant,
  subclassOf
} = require('../../utils/enchants');

const slot = (type, name = type) => ({ type, name });

const item = (slotType, { enchants = [], subclass, name = 'Thing' } = {}) => ({
  slot: slot(slotType),
  name,
  item: { id: 1 },
  item_subclass: subclass ? { type: subclass } : undefined,
  enchantments: enchants
});

const permanent = () => ({
  display_string: 'Enchanted: +35 Healing',
  enchantment_slot: { id: 0, type: 'PERMANENT' }
});

const gem = label => ({ display_string: label, enchantment_slot: { id: 2 } });

describe('expectsEnchant', () => {
  it.each(['HEAD', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'LEGS', 'FEET', 'MAIN_HAND'])(
    'expects an enchant on %s',
    slotType => {
      expect(expectsEnchant(item(slotType))).toBe(true);
    }
  );

  // The whole point of the slot list: these cannot be enchanted in TBC, so
  // reporting them as missing would be permanent noise.
  it.each(['NECK', 'WAIST', 'TRINKET_1', 'TRINKET_2', 'SHIRT', 'TABARD'])(
    'does not expect an enchant on %s',
    slotType => {
      expect(expectsEnchant(item(slotType))).toBe(false);
    }
  );

  it('expects an off-hand enchant only on weapons and shields', () => {
    expect(expectsEnchant(item('OFF_HAND', { subclass: 'SHIELD' }))).toBe(true);
    expect(expectsEnchant(item('OFF_HAND', { subclass: 'ONE_HANDED_SWORD' }))).toBe(true);
    // A held-in-off-hand tome or orb takes nothing.
    expect(expectsEnchant(item('OFF_HAND', { subclass: 'MISCELLANEOUS' }))).toBe(false);
  });

  it('expects a ranged scope only on things that shoot', () => {
    expect(expectsEnchant(item('RANGED', { subclass: 'BOW' }))).toBe(true);
    expect(expectsEnchant(item('RANGED', { subclass: 'GUN' }))).toBe(true);
    // Relics take no enchant.
    expect(expectsEnchant(item('RANGED', { subclass: 'IDOL' }))).toBe(false);
    expect(expectsEnchant(item('RANGED', { subclass: 'LIBRAM' }))).toBe(false);
  });

  it('handles a malformed item', () => {
    expect(expectsEnchant({})).toBe(false);
    expect(expectsEnchant(null)).toBe(false);
  });
});

describe('subclassOf', () => {
  it('normalizes spacing and case', () => {
    expect(subclassOf({ item_subclass: { type: 'one_handed_sword' } })).toBe('ONE_HANDED_SWORD');
    expect(subclassOf({ item_subclass: { name: 'Fist Weapon' } })).toBe('FIST_WEAPON');
  });

  it('is empty when absent', () => {
    expect(subclassOf({})).toBe('');
  });
});

describe('permanentEnchant and gems', () => {
  const socketed = item('HEAD', { enchants: [permanent(), gem('+18 Stamina'), gem('+8 Hit')] });

  it('separates the enchant from the gems by slot type', () => {
    expect(permanentEnchant(socketed).display_string).toContain('Healing');
    expect(gems(socketed)).toHaveLength(2);
  });

  it('reports no enchant when only gems are present', () => {
    const gemsOnly = item('HEAD', { enchants: [gem('+18 Stamina')] });

    expect(permanentEnchant(gemsOnly)).toBeUndefined();
    expect(gems(gemsOnly)).toHaveLength(1);
  });
});

describe('auditEquipment', () => {
  it('separates missing, optional, and enchanted slots', () => {
    const audit = auditEquipment({
      equipped_items: [
        item('HEAD', { enchants: [permanent()] }),
        item('CHEST'), // missing
        item('LEGS'), // missing
        item('FINGER_1'), // optional, unenchanted
        item('FINGER_2', { enchants: [permanent()] }), // optional, enchanted
        item('NECK'), // never enchantable
        item('TABARD') // never enchantable
      ]
    });

    expect(audit.missing.map(m => m.item.slot.type)).toEqual(['CHEST', 'LEGS']);
    expect(audit.optional.map(m => m.item.slot.type)).toEqual(['FINGER_1']);
    expect(audit.requiredTotal).toBe(3); // head, chest, legs
    expect(audit.requiredEnchanted).toBe(1);
    expect(audit.optionalEnchanted).toBe(1);
  });

  it('does not count unenchantable slots as missing', () => {
    const audit = auditEquipment({
      equipped_items: [item('NECK'), item('WAIST'), item('TRINKET_1'), item('SHIRT')]
    });

    expect(audit.missing).toEqual([]);
    expect(audit.checked).toBe(0);
  });

  it('counts gems across every item', () => {
    const audit = auditEquipment({
      equipped_items: [
        item('HEAD', { enchants: [permanent(), gem('a'), gem('b')] }),
        item('NECK', { enchants: [gem('c')] })
      ]
    });

    expect(audit.gemCount).toBe(3);
  });

  it('handles empty or missing equipment', () => {
    expect(auditEquipment(null).checked).toBe(0);
    expect(auditEquipment({ equipped_items: [] }).missing).toEqual([]);
  });

  it('reports a fully enchanted character cleanly', () => {
    const audit = auditEquipment({
      equipped_items: ['HEAD', 'CHEST', 'LEGS'].map(s => item(s, { enchants: [permanent()] }))
    });

    expect(audit.missing).toEqual([]);
    expect(audit.requiredEnchanted).toBe(audit.requiredTotal);
  });
});
