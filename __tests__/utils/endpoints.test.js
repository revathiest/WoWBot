jest.mock('../../utils/blizzard/client', () => ({
  request: jest.fn(async () => ({}))
}));

const { request } = require('../../utils/blizzard/client');
const profile = require('../../utils/blizzard/profile');
const gameData = require('../../utils/blizzard/gameData');
const guild = require('../../utils/blizzard/guild');

beforeEach(() => {
  request.mockClear();
});

const lastCall = () => request.mock.calls[request.mock.calls.length - 1];

describe('profile endpoints', () => {
  // Classic Forever characters have no realm: the whole address is one
  // `{name}-{surname}` slug. Verified live: this exact path 200s under
  // profile-forever-eu.
  it('addresses a character by its single slug', () => {
    expect(profile.characterPath('judgement-judy')).toBe('/profile/wow/character/judgement-judy');
    expect(profile.characterPath('judgement-judy', '/equipment')).toBe(
      '/profile/wow/character/judgement-judy/equipment'
    );
  });

  it.each([
    ['getCharacterProfile', '/profile/wow/character/judgement-judy'],
    ['getCharacterMedia', '/profile/wow/character/judgement-judy/character-media'],
    ['getCharacterEquipment', '/profile/wow/character/judgement-judy/equipment'],
    ['getCharacterPvpSummary', '/profile/wow/character/judgement-judy/pvp-summary']
  ])('%s targets %s in the profile namespace', async (method, expectedPath) => {
    await profile[method]('judgement-judy', { region: 'us' });

    const [path, options] = lastCall();
    expect(path).toBe(expectedPath);
    expect(options.namespace).toBe('profile');
    expect(options.region).toBe('us');
  });
});

describe('game data endpoints', () => {
  it('reads items and item media from the static namespace', async () => {
    await gameData.getItem(19019, { region: 'us' });
    expect(lastCall()[0]).toBe('/data/wow/item/19019');
    expect(lastCall()[1].namespace).toBe('static');

    await gameData.getItemMedia(19019, { region: 'us' });
    expect(lastCall()[0]).toBe('/data/wow/media/item/19019');
    expect(lastCall()[1].namespace).toBe('static');
  });

  it('reads the playable class index from the static namespace', async () => {
    await gameData.getPlayableClassIndex({ region: 'us' });
    expect(lastCall()[0]).toBe('/data/wow/playable-class/index');
    expect(lastCall()[1].namespace).toBe('static');
  });

  it('searches items by the locale-qualified name field', async () => {
    await gameData.searchItems('Thunderfury', { region: 'us', locale: 'en_US' });

    const [path, options] = lastCall();
    expect(path).toBe('/data/wow/search/item');
    expect(options.namespace).toBe('static');
    expect(options.searchParams['name.en_US']).toBe('Thunderfury');
    expect(options.searchParams.orderby).toBe('id');
    expect(options.searchParams._page).toBe(1);
  });

  it('uses the configured locale for search when none is given', async () => {
    await gameData.searchItems('Donnerzorn', {
      region: 'eu',
      config: { blizzard: { locale: 'de_DE', region: 'eu' } }
    });

    expect(lastCall()[1].searchParams['name.de_DE']).toBe('Donnerzorn');
  });

  it('lets callers add their own search params', async () => {
    await gameData.searchItems('Thunderfury', {
      region: 'us',
      locale: 'en_US',
      searchParams: { _page: 3 }
    });

    expect(lastCall()[1].searchParams._page).toBe(3);
  });

  it('reads the ruleset index from the dynamic namespace', () => {
    gameData.getRulesetIndex({ region: 'eu' });

    expect(lastCall()[0]).toBe('/data/wow/ruleset/index');
    expect(lastCall()[1]).toMatchObject({ namespace: 'dynamic' });
  });

  it('reads one ruleset by id', () => {
    gameData.getRuleset(15, { region: 'eu' });

    expect(lastCall()[0]).toBe('/data/wow/ruleset/15');
  });

  it('keeps the trailing slash on the auction index, which Blizzard requires', () => {
    // Without it the endpoint 404s. Nothing else in this API behaves that way.
    gameData.getRulesetAuctionIndex(1, { region: 'eu' });

    expect(lastCall()[0]).toBe('/data/wow/ruleset/1/auctions/');
  });
});

describe('guild endpoints', () => {
  // Guilds are one path segment too, with no realm. Verified live, and the
  // guild reference inside a character profile points at exactly this shape.
  it('addresses a guild by its slug alone', () => {
    guild.getGuild('circle-of-lore', { region: 'eu' });
    expect(lastCall()[0]).toBe('/data/wow/guild/circle-of-lore');
    expect(lastCall()[1]).toMatchObject({ namespace: 'profile' });
  });

  it('addresses a guild roster the same way', () => {
    guild.getGuildRoster('circle-of-lore', { region: 'eu' });
    expect(lastCall()[0]).toBe('/data/wow/guild/circle-of-lore/roster');
    expect(lastCall()[1]).toMatchObject({ namespace: 'profile' });
  });
});
