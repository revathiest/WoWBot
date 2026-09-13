jest.mock('../../utils/blizzard/profile', () => ({
  getCharacterProfile: jest.fn(),
  getCharacterEquipment: jest.fn()
}));

jest.mock('../../utils/blizzard/realms', () => ({
  resolveRealm: jest.fn(async query => ({
    slug: String(query).toLowerCase(),
    name: query,
    resolved: true
  }))
}));

const { getCharacterProfile, getCharacterEquipment } = require('../../utils/blizzard/profile');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const command = require('../../commands/wow/audit');
const { field } = require('../helpers/interaction');

function interaction(options = {}) {
  return {
    options: {
      getString: name => options[name] ?? null,
      getInteger: () => null,
      getBoolean: () => null,
      getSubcommand: () => null,
      getSubcommandGroup: () => null
    },
    deferReply: jest.fn(async () => {}),
    editReply: jest.fn(async () => {})
  };
}

const payload = target => target.editReply.mock.calls[target.editReply.mock.calls.length - 1][0];
const embedOf = target => payload(target).embeds[0].toJSON();

const permanent = () => ({
  display_string: 'Enchanted: +35 Healing',
  enchantment_slot: { id: 0, type: 'PERMANENT' }
});
const gem = () => ({ display_string: '+18 Stamina', enchantment_slot: { id: 2 } });

const slotItem = (type, name, enchants = []) => ({
  slot: { type, name: type },
  name,
  item: { id: 31988 },
  enchantments: enchants
});

const PROFILE = {
  name: 'Zuggbeard',
  character_class: { name: 'Warrior' },
  equipped_item_level: 128
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  getCharacterProfile.mockResolvedValue(PROFILE);
});

afterEach(() => jest.restoreAllMocks());

describe('/audit', () => {
  it('flags missing enchants and links each item', async () => {
    getCharacterEquipment.mockResolvedValue({
      equipped_items: [
        slotItem('HEAD', 'Plate Helm'),
        slotItem('CHEST', 'Plate Chest'),
        slotItem('LEGS', 'Plate Legs', [permanent()])
      ]
    });
    const target = interaction({ character: 'Zuggbeard', realm: 'Nightslayer', game: 'anniversary' });

    await command.execute(target);

    const embed = embedOf(target);
    expect(embed.description).toContain('2 missing enchants');
    expect(field(embed, 'Enchanted').value).toBe('1 / 3');

    const missing = field(embed, 'Missing Enchants').value;
    expect(missing).toContain('HEAD');
    expect(missing).toContain('Plate Helm');
    // Items link to the Wowhead database for the right game version.
    expect(missing).toContain('wowhead.com/tbc/item=31988');
  });

  it('passes a fully enchanted character', async () => {
    getCharacterEquipment.mockResolvedValue({
      equipped_items: [
        slotItem('HEAD', 'Helm', [permanent()]),
        slotItem('CHEST', 'Chest', [permanent()])
      ]
    });
    const target = interaction({ character: 'Mindbugger', realm: 'Nightslayer' });

    await command.execute(target);

    const embed = embedOf(target);
    expect(embed.description).toContain('All 2 enchantable slots');
    expect(field(embed, 'Missing Enchants')).toBeUndefined();
  });

  it('counts rings separately, since only enchanters can enchant them', async () => {
    getCharacterEquipment.mockResolvedValue({
      equipped_items: [
        slotItem('HEAD', 'Helm', [permanent()]),
        slotItem('FINGER_1', 'Ring One', [permanent()]),
        slotItem('FINGER_2', 'Ring Two')
      ]
    });
    const target = interaction({ character: 'X', realm: 'Nightslayer' });

    await command.execute(target);

    const embed = embedOf(target);
    // One required slot enchanted, plus one optional ring — not "2 / 3".
    expect(field(embed, 'Enchanted').value).toBe('1 / 1 (+1 ring)');
    expect(field(embed, 'Rings (enchanters only)').value).toContain('Ring Two');
  });

  it('never reports slots TBC cannot enchant', async () => {
    getCharacterEquipment.mockResolvedValue({
      equipped_items: [
        slotItem('HEAD', 'Helm', [permanent()]),
        slotItem('NECK', 'Necklace'),
        slotItem('WAIST', 'Belt'),
        slotItem('TRINKET_1', 'Trinket'),
        slotItem('TABARD', 'Tabard')
      ]
    });
    const target = interaction({ character: 'X', realm: 'Nightslayer' });

    await command.execute(target);

    expect(field(embedOf(target), 'Missing Enchants')).toBeUndefined();
  });

  it('counts gems but says they cannot be audited', async () => {
    getCharacterEquipment.mockResolvedValue({
      equipped_items: [slotItem('HEAD', 'Helm', [permanent(), gem(), gem()])]
    });
    const target = interaction({ character: 'X', realm: 'Nightslayer' });

    await command.execute(target);

    const embed = embedOf(target);
    expect(field(embed, 'Gems').value).toBe('2');
    // Blizzard never exposes empty sockets, so this limit must be stated.
    expect(embed.footer.text).toContain('does not expose empty sockets');
  });

  it('still renders when the profile cannot be loaded', async () => {
    getCharacterProfile.mockRejectedValue(new Error('profile down'));
    getCharacterEquipment.mockResolvedValue({
      equipped_items: [slotItem('HEAD', 'Helm', [permanent()])]
    });
    const target = interaction({ character: 'X', realm: 'Nightslayer' });

    await command.execute(target);

    expect(embedOf(target).title).toContain('X');
  });

  it('explains a missing character', async () => {
    getCharacterEquipment.mockRejectedValue(new BlizzardApiError('Not found.', { status: 404 }));
    const target = interaction({ character: 'Nobody', realm: 'Nightslayer' });

    await command.execute(target);

    expect(payload(target)).toContain('No character named');
  });

  it('rethrows other failures', async () => {
    getCharacterEquipment.mockRejectedValue(new BlizzardApiError('boom', { status: 500 }));

    await expect(
      command.execute(interaction({ character: 'X', realm: 'Nightslayer' }))
    ).rejects.toThrow('boom');
  });

  it('says so when nothing equipped takes an enchant', async () => {
    getCharacterEquipment.mockResolvedValue({ equipped_items: [slotItem('TABARD', 'Tabard')] });
    const target = interaction({ character: 'X', realm: 'Nightslayer' });

    await command.execute(target);

    expect(payload(target)).toContain('nothing equipped that takes an enchant');
  });
});
