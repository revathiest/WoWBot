jest.mock('../../utils/blizzard/profile', () => ({
  getCharacterProfile: jest.fn(),
  getCharacterMedia: jest.fn(),
  getCharacterEquipment: jest.fn()
}));

const {
  getCharacterProfile,
  getCharacterMedia,
  getCharacterEquipment
} = require('../../utils/blizzard/profile');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const command = require('../../commands/wow/character');
const { createInteraction, field, replyEmbed, replyPayload } = require('../helpers/interaction');

const PROFILE = {
  name: 'Judgement',
  surname: 'Judy',
  level: 18,
  race: { name: 'Human' },
  character_class: { name: 'Paladin' },
  faction: { name: 'Alliance' },
  guild: { name: 'Circle of Lore' },
  ruleset: { id: 2, name: 'Normal' },
  equipped_item_level: 8,
  average_item_level: 8,
  achievement_points: 0,
  last_login_timestamp: 1700000000000
};

const MEDIA = {
  assets: [
    { key: 'avatar', value: 'https://render/avatar.jpg' },
    { key: 'main-raw', value: 'https://render/main.png' }
  ]
};

const EQUIPMENT = {
  equipped_items: [
    { slot: { type: 'HEAD', name: 'Head' }, name: 'Kodohide Helm', item: { id: 31988 } },
    { slot: { type: 'CHEST', name: 'Chest' }, name: 'Kodohide Tunic', item: { id: 33694 }, level: { value: 8 } },
    { slot: { type: 'SHIRT', name: 'Shirt' }, name: 'Orange Martial Shirt', item: { id: 2575 } },
    { slot: { type: 'TABARD', name: 'Tabard' }, name: 'Tabard of the Protector', item: { id: 31404 } },
    { slot: { type: 'MAIN_HAND', name: 'Main Hand' }, name: 'Rusty Sword', item: { id: 29981 } }
  ]
};

function interaction(overrides = {}) {
  return createInteraction({
    commandName: 'character',
    options: { character: 'Judgement-Judy', ...overrides }
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  getCharacterProfile.mockResolvedValue(PROFILE);
  getCharacterMedia.mockResolvedValue(MEDIA);
  getCharacterEquipment.mockResolvedValue(EQUIPMENT);
});

afterEach(() => jest.restoreAllMocks());

describe('/character definition', () => {
  it('requires only a character name', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('character');
    expect(json.options.map(option => [option.name, option.required])).toEqual([
      ['character', true],
      ['surname', false],
      ['region', false]
    ]);
  });
});

describe('/character execute', () => {
  it('defers, then answers with a populated embed', async () => {
    const target = interaction();

    await command.execute(target);

    expect(target.deferReply).toHaveBeenCalled();

    const embed = replyEmbed(target);
    expect(embed.title).toBe('Judgement Judy — Normal (US)');
    expect(embed.url).toBeUndefined();
    expect(field(embed, 'Level').value).toBe('18');
    expect(field(embed, 'Class').value).toBe('Paladin');
    expect(field(embed, 'Item Level').value).toBe('8 equipped / 8 avg');
    expect(field(embed, 'Achievements').value).toBe('0');
    expect(field(embed, 'Guild').value).toBe('<Circle of Lore>');
    expect(field(embed, 'Last Login').value).toBe('<t:1700000000:R>');
    expect(embed.thumbnail.url).toBe('https://render/avatar.jpg');
    expect(embed.image.url).toBe('https://render/main.png');
  });

  it('tints the embed with the class colour', () => {
    const embed = command.buildEmbed({ profile: PROFILE, media: null, scopeLabel: 'US' });
    expect(embed.toJSON().color).toBe(0xf48cba); // Paladin pink
  });

  it('accepts the character and surname as separate options', async () => {
    const target = interaction({ character: 'Judgement', surname: 'Judy' });
    await command.execute(target);

    expect(getCharacterProfile).toHaveBeenCalledWith('judgement-judy', { region: 'us' });
  });

  it('passes the chosen region through to the API', async () => {
    await command.execute(interaction({ region: 'eu' }));

    expect(getCharacterProfile).toHaveBeenCalledWith('judgement-judy', { region: 'eu' });
  });

  it('lists equipped items in paperdoll order, linked to Wowhead', async () => {
    const target = interaction();

    await command.execute(target);

    const gear = field(replyEmbed(target), 'Equipment').value;
    const lines = gear.split('\n');

    expect(lines[0]).toBe('**Head** [Kodohide Helm](https://www.wowhead.com/classic/item=31988)');
    // Item level is appended only when the API supplies one.
    expect(lines[1]).toBe('**Chest** [Kodohide Tunic](https://www.wowhead.com/classic/item=33694) · 8');
    expect(lines[2]).toContain('Main Hand');
  });

  it('omits cosmetic slots', async () => {
    const target = interaction();

    await command.execute(target);

    const gear = field(replyEmbed(target), 'Equipment').value;
    expect(gear).not.toContain('Martial Shirt');
    expect(gear).not.toContain('Tabard');
  });

  it('splits equipment across fields within Discord limits', () => {
    const many = {
      equipped_items: command.EQUIPMENT_SLOTS.map((slot, i) => ({
        slot: { type: slot, name: slot },
        name: 'A rather long item name for padding purposes ' + i,
        item: { id: 100000 + i }
      }))
    };

    const fields = command.equipmentFields(many);

    expect(fields.length).toBeGreaterThan(1);
    fields.forEach(f => expect(f.value.length).toBeLessThanOrEqual(1024));
    expect(fields[0].name).toBe('Equipment');
    expect(fields[1].name).toBe('​');
  });

  it('adds no equipment fields when gear is unavailable', () => {
    expect(command.equipmentFields(null)).toEqual([]);
    expect(command.equipmentFields({ equipped_items: [] })).toEqual([]);
  });

  it('still replies when the gear cannot be loaded', async () => {
    getCharacterEquipment.mockRejectedValue(new Error('equipment down'));
    const target = interaction();

    await command.execute(target);

    const embed = replyEmbed(target);
    expect(embed.title).toContain('Judgement Judy');
    expect(field(embed, 'Equipment')).toBeUndefined();
  });

  it('still replies when the artwork cannot be loaded', async () => {
    getCharacterMedia.mockRejectedValue(new Error('media down'));
    const target = interaction();

    await command.execute(target);

    const embed = replyEmbed(target);
    expect(embed.title).toContain('Judgement Judy');
    expect(embed.thumbnail).toBeUndefined();
  });

  it('asks for a surname instead of a bare name', async () => {
    const target = interaction({ character: 'Judgement' });

    await command.execute(target);

    expect(replyPayload(target)).toContain('surname');
    expect(getCharacterProfile).not.toHaveBeenCalled();
  });

  it('explains a missing character', async () => {
    getCharacterProfile.mockRejectedValue(new BlizzardApiError('Not found.', { status: 404 }));
    const target = interaction({ character: 'Nobody-Smith' });

    await command.execute(target);

    const payload = replyPayload(target);
    expect(payload).toContain('Nobody Smith');
    expect(getCharacterMedia).not.toHaveBeenCalled();
  });

  it('rethrows non-404 failures for the interaction handler', async () => {
    getCharacterProfile.mockRejectedValue(new BlizzardApiError('boom', { status: 500 }));

    await expect(command.execute(interaction())).rejects.toThrow('boom');
  });

  it('copes with a sparse profile payload', () => {
    const embed = command.buildEmbed({ profile: { name: 'Nub', surname: 'One' }, media: null, scopeLabel: 'US' }).toJSON();

    expect(field(embed, 'Level').value).toBe('—');
    expect(field(embed, 'Race').value).toBe('—');
    expect(field(embed, 'Guild')).toBeUndefined();
    expect(field(embed, 'Last Login')).toBeUndefined();
  });
});
