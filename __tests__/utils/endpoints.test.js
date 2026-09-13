jest.mock('../../utils/blizzard/client', () => ({
  request: jest.fn(async () => ({}))
}));

const { request } = require('../../utils/blizzard/client');
const profile = require('../../utils/blizzard/profile');
const gameData = require('../../utils/blizzard/gameData');

beforeEach(() => {
  request.mockClear();
});

const lastCall = () => request.mock.calls[request.mock.calls.length - 1];

describe('profile endpoints', () => {
  it('uses the realm slug verbatim and lowercases the character name', () => {
    expect(profile.characterPath('area-52', 'Thrall')).toBe(
      '/profile/wow/character/area-52/thrall'
    );
    expect(profile.characterPath('malganis', 'Sylvanas', '/equipment')).toBe(
      '/profile/wow/character/malganis/sylvanas/equipment'
    );
  });

  it('never re-slugifies the realm', () => {
    // Regression: slugifyRealm deletes hyphens, so applying it to a slug that
    // already has one produced "area52" and every lookup 404'd.
    expect(profile.characterPath('area-52', 'Thrall')).toContain('/area-52/');
    expect(profile.characterPath('argent-dawn', 'X')).toContain('/argent-dawn/');
  });

  it.each([
    ['getCharacterProfile', [], '/profile/wow/character/area-52/thrall'],
    ['getCharacterMedia', [], '/profile/wow/character/area-52/thrall/character-media'],
    ['getCharacterEquipment', [], '/profile/wow/character/area-52/thrall/equipment'],
    ['getMythicKeystoneProfile', [], '/profile/wow/character/area-52/thrall/mythic-keystone-profile']
  ])('%s targets %s in the profile namespace', async (method, extraArgs, expectedPath) => {
    await profile[method]('area-52', 'Thrall', ...extraArgs, { region: 'us' });

    const [path, options] = lastCall();
    expect(path).toBe(expectedPath);
    expect(options.namespace).toBe('profile');
    expect(options.region).toBe('us');
  });

  it('includes the season id when fetching a keystone season', async () => {
    await profile.getMythicKeystoneSeason('area-52', 'Thrall', 14, { region: 'eu' });

    const [path, options] = lastCall();
    expect(path).toBe('/profile/wow/character/area-52/thrall/mythic-keystone-profile/season/14');
    expect(options.namespace).toBe('profile');
    expect(options.region).toBe('eu');
  });
});

describe('game data endpoints', () => {
  it('reads the token price from the dynamic namespace', async () => {
    await gameData.getWowTokenPrice({ region: 'us' });

    const [path, options] = lastCall();
    expect(path).toBe('/data/wow/token/index');
    expect(options.namespace).toBe('dynamic');
  });

  it('reads the realm index', async () => {
    await gameData.getRealmIndex({ region: 'us' });

    const [path, options] = lastCall();
    expect(path).toBe('/data/wow/realm/index');
    expect(options.namespace).toBe('dynamic');
  });

  it('uses the realm slug verbatim when fetching a realm', async () => {
    await gameData.getRealm('area-52', { region: 'us' });

    const [path, options] = lastCall();
    expect(path).toBe('/data/wow/realm/area-52');
    expect(options.namespace).toBe('dynamic');
  });

  it('does not mangle a hyphenated slug', async () => {
    await gameData.getRealm('argent-dawn', { region: 'us' });
    expect(lastCall()[0]).toBe('/data/wow/realm/argent-dawn');
  });

  it('fetches a connected realm by id', async () => {
    await gameData.getConnectedRealm(11, { region: 'us' });

    expect(lastCall()[0]).toBe('/data/wow/connected-realm/11');
  });

  it('reads items and item media from the static namespace', async () => {
    await gameData.getItem(19019, { region: 'us' });
    expect(lastCall()[0]).toBe('/data/wow/item/19019');
    expect(lastCall()[1].namespace).toBe('static');

    await gameData.getItemMedia(19019, { region: 'us' });
    expect(lastCall()[0]).toBe('/data/wow/media/item/19019');
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
});
