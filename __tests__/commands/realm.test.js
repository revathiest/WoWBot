jest.mock('../../utils/blizzard/gameData', () => ({
  getRealm: jest.fn(),
  getConnectedRealm: jest.fn(),
  getRealmIndex: jest.fn()
}));

jest.mock('../../utils/blizzard/realms', () => ({
  resolveRealm: jest.fn(),
  findRealmGames: jest.fn(async () => []),
  getPlayableRealms: jest.fn(async () => []),
  searchRealms: jest.requireActual('../../utils/blizzard/realms').searchRealms
}));

const { getRealm, getConnectedRealm } = require('../../utils/blizzard/gameData');
const { resolveRealm, getPlayableRealms, findRealmGames } = require('../../utils/blizzard/realms');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const command = require('../../commands/wow/realm');
const { createInteraction, field, replyEmbed, replyPayload } = require('../helpers/interaction');

const REALM = {
  id: 3676,
  name: 'Area 52',
  slug: 'area-52',
  category: 'United States',
  timezone: 'America/New_York',
  type: { type: 'NORMAL', name: 'Normal' },
  connected_realm: {
    href: 'https://us.api.blizzard.com/data/wow/connected-realm/3676?namespace=dynamic-us'
  }
};

const CONNECTED = {
  id: 3676,
  has_queue: false,
  status: { type: 'UP', name: 'Up' },
  population: { type: 'FULL', name: 'Full' },
  realms: [{ name: 'Area 52' }, { name: 'Zangarmarsh' }]
};

function interaction(overrides = {}) {
  return createInteraction({ commandName: 'realm', options: { realm: 'Area 52', ...overrides } });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  getRealm.mockResolvedValue(REALM);
  getConnectedRealm.mockResolvedValue(CONNECTED);
  resolveRealm.mockImplementation(async query => ({
    slug: String(query).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().replace(/ +/g, '-'),
    name: query,
    resolved: true
  }));
  getPlayableRealms.mockResolvedValue([]);
  findRealmGames.mockResolvedValue([]);
});

afterEach(() => jest.restoreAllMocks());

describe('/realm', () => {
  it('requires a realm and takes optional game and region', () => {
    const json = command.data.toJSON();

    expect(json.options.map(option => [option.name, option.required])).toEqual([
      ['realm', true],
      ['game', false],
      ['region', false]
    ]);
  });

  it('shows status, population, and connected realms', async () => {
    const target = interaction();

    await command.execute(target);

    expect(getConnectedRealm).toHaveBeenCalledWith(3676, { region: 'us', game: 'retail' });

    const embed = replyEmbed(target);
    expect(embed.title).toBe('Area 52 (US)');
    expect(field(embed, 'Status').value).toBe('🟢 Up');
    expect(field(embed, 'Population').value).toBe('Full');
    expect(field(embed, 'Queue').value).toBe('No');
    expect(field(embed, 'Connected Realms').value).toBe('Area 52, Zangarmarsh');
    expect(embed.color).toBe(0x43b581);
  });

  it('turns the embed red when a realm is down', () => {
    const embed = command
      .buildEmbed({
        realm: REALM,
        connectedRealm: { ...CONNECTED, status: { type: 'DOWN', name: 'Down' }, has_queue: true },
        scope: { region: 'us', game: 'retail', label: 'US' }
      })
      .toJSON();

    expect(embed.color).toBe(0xf04747);
    expect(field(embed, 'Status').value).toBe('🔴 Down');
    expect(field(embed, 'Queue').value).toBe('Yes');
  });

  it('still replies when the connected realm cannot be loaded', async () => {
    getConnectedRealm.mockRejectedValue(new Error('down'));
    const target = interaction();

    await command.execute(target);

    const embed = replyEmbed(target);
    expect(field(embed, 'Type').value).toBe('Normal');
    expect(field(embed, 'Status')).toBeUndefined();
  });

  it('skips the connected-realm call when there is no reference', async () => {
    getRealm.mockResolvedValue({ ...REALM, connected_realm: undefined });

    await command.execute(interaction());

    expect(getConnectedRealm).not.toHaveBeenCalled();
  });

  it('suggests near matches when the realm is unknown', async () => {
    getRealm.mockRejectedValue(new BlizzardApiError('Not found.', { status: 404 }));
    getPlayableRealms.mockResolvedValue([
      { name: 'Area 52', slug: 'area-52' },
      { name: 'Argent Dawn', slug: 'argent-dawn' }
    ]);
    const target = interaction({ realm: 'Area' });

    await command.execute(target);

    const payload = replyPayload(target);
    expect(payload).toContain('No realm called');
    expect(payload).toContain('Did you mean: Area 52?');
  });

  it('omits suggestions when the index cannot be read', async () => {
    getRealm.mockRejectedValue(new BlizzardApiError('Not found.', { status: 404 }));
    getPlayableRealms.mockRejectedValue(new Error('index down'));
    const target = interaction({ realm: 'Nonsense' });

    await command.execute(target);

    expect(replyPayload(target)).not.toContain('Did you mean');
  });

  it('names the game version that actually has the realm', async () => {
    getRealm.mockRejectedValue(new BlizzardApiError('Not found.', { status: 404 }));
    findRealmGames.mockResolvedValue([
      { game: 'anniversary', label: 'TBC Anniversary', realm: { slug: 'nightslayer' } }
    ]);

    const target = interaction({ realm: 'Nightslayer' });
    await command.execute(target);

    expect(replyPayload(target)).toContain('game:TBC Anniversary');
  });

  it('rethrows failures that are not a missing realm', async () => {
    getRealm.mockRejectedValue(new BlizzardApiError('boom', { status: 500 }));

    await expect(command.execute(interaction())).rejects.toThrow('boom');
  });

  it('hides the connected-realm list for a standalone realm', () => {
    const embed = command
      .buildEmbed({ realm: REALM, connectedRealm: { ...CONNECTED, realms: [{ name: 'Area 52' }] }, scope: { region: 'us', game: 'retail', label: 'US' } })
      .toJSON();

    expect(field(embed, 'Connected Realms')).toBeUndefined();
  });
});
