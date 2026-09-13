jest.mock('../../utils/blizzard/profile', () => ({
  getCharacterProfile: jest.fn(),
  getCharacterMedia: jest.fn()
}));

// The realm resolver reads the live realm index; stub it so tests stay offline.
jest.mock('../../utils/blizzard/realms', () => ({
  resolveRealm: jest.fn(async query => ({
    slug: String(query).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().replace(/ +/g, '-'),
    name: query,
    resolved: true
  }))
}));

const { getCharacterProfile, getCharacterMedia } = require('../../utils/blizzard/profile');
const { resolveRealm } = require('../../utils/blizzard/realms');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const command = require('../../commands/wow/character');
const { createInteraction, field, replyEmbed, replyPayload } = require('../helpers/interaction');

const PROFILE = {
  name: 'Thrall',
  level: 80,
  race: { name: 'Orc' },
  character_class: { name: 'Shaman' },
  active_spec: { name: 'Enhancement' },
  faction: { name: 'Horde' },
  guild: { name: 'Earthen Ring' },
  realm: { name: 'Area 52', slug: 'area-52' },
  equipped_item_level: 623,
  average_item_level: 620,
  achievement_points: 24500,
  last_login_timestamp: 1700000000000,
  active_title: { display_string: '{name} the Earth-Warder' }
};

const MEDIA = {
  assets: [
    { key: 'avatar', value: 'https://render/avatar.jpg' },
    { key: 'main-raw', value: 'https://render/main.png' }
  ]
};

function interaction(overrides = {}) {
  return createInteraction({
    commandName: 'character',
    options: { character: 'Thrall', realm: 'Area 52', ...overrides }
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  getCharacterProfile.mockResolvedValue(PROFILE);
  getCharacterMedia.mockResolvedValue(MEDIA);
  resolveRealm.mockImplementation(async query => ({
    slug: String(query).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().replace(/ +/g, '-'),
    name: query,
    resolved: true
  }));
});

afterEach(() => jest.restoreAllMocks());

describe('/character definition', () => {
  it('requires a character and realm, and offers optional game and region', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('character');
    expect(json.options.map(option => [option.name, option.required])).toEqual([
      ['character', true],
      ['realm', true],
      ['game', false],
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
    expect(embed.title).toBe('Thrall — Area 52 (US)');
    expect(embed.url).toContain('/character/us/area-52/thrall');
    expect(field(embed, 'Level').value).toBe('80');
    expect(field(embed, 'Class').value).toBe('Enhancement Shaman');
    expect(field(embed, 'Item Level').value).toBe('623 equipped / 620 avg');
    expect(field(embed, 'Achievements').value).toBe('24,500');
    expect(field(embed, 'Guild').value).toBe('<Earthen Ring>');
    expect(field(embed, 'Title').value).toBe('Thrall the Earth-Warder');
    expect(field(embed, 'Last Login').value).toBe('<t:1700000000:R>');
    expect(embed.thumbnail.url).toBe('https://render/avatar.jpg');
    expect(embed.image.url).toBe('https://render/main.png');
  });

  it('tints the embed with the class colour', () => {
    const embed = command.buildEmbed({
      profile: PROFILE,
      media: null,
      region: 'us',
      realmSlug: 'area-52',
      characterName: 'Thrall',
      scopeLabel: 'US'
    });

    expect(embed.toJSON().color).toBe(0x0070dd); // Shaman blue
  });

  it('passes the chosen region through to the API', async () => {
    await command.execute(interaction({ region: 'eu' }));

    expect(getCharacterProfile).toHaveBeenCalledWith(
      'area-52',
      'Thrall',
      expect.objectContaining({ region: 'eu', game: 'retail' })
    );
  });

  it('still replies when the artwork cannot be loaded', async () => {
    getCharacterMedia.mockRejectedValue(new Error('media down'));
    const target = interaction();

    await command.execute(target);

    const embed = replyEmbed(target);
    expect(embed.title).toContain('Thrall');
    expect(embed.thumbnail).toBeUndefined();
  });

  it('explains a missing character and names the slug it tried', async () => {
    getCharacterProfile.mockRejectedValue(new BlizzardApiError('Not found.', { status: 404 }));
    const target = interaction({ character: 'Nobody', realm: "Mal'Ganis" });

    await command.execute(target);

    const payload = replyPayload(target);
    expect(payload).toContain('Nobody');
    expect(payload).toContain('malganis');
    expect(getCharacterMedia).not.toHaveBeenCalled();
  });

  it('rethrows non-404 failures for the interaction handler', async () => {
    getCharacterProfile.mockRejectedValue(new BlizzardApiError('boom', { status: 500 }));

    await expect(command.execute(interaction())).rejects.toThrow('boom');
  });

  it('copes with a sparse profile payload', () => {
    const embed = command
      .buildEmbed({
        profile: { name: 'Nub', realm: {} },
        media: null,
        region: 'us',
        realmSlug: 'area-52',
        characterName: 'Nub'
      })
      .toJSON();

    expect(field(embed, 'Level').value).toBe('—');
    expect(field(embed, 'Race').value).toBe('—');
    expect(field(embed, 'Guild')).toBeUndefined();
    expect(field(embed, 'Title')).toBeUndefined();
    expect(field(embed, 'Last Login')).toBeUndefined();
  });
});
