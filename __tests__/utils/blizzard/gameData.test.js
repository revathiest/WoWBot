jest.mock('../../../utils/blizzard/client');

const { request } = require('../../../utils/blizzard/client');
const {
  getItem,
  getItemMedia,
  getPlayableClassIndex,
  getRuleset,
  getRulesetAuctionIndex,
  getRulesetIndex,
  searchItems
} = require('../../../utils/blizzard/gameData');

beforeEach(() => {
  jest.clearAllMocks();
  request.mockResolvedValue({ ok: true });
});

describe('getRulesetIndex', () => {
  it('requests the ruleset index under the dynamic namespace', async () => {
    await getRulesetIndex();

    expect(request).toHaveBeenCalledWith('/data/wow/ruleset/index', { namespace: 'dynamic' });
  });

  it('forwards caller options alongside the namespace', async () => {
    await getRulesetIndex({ region: 'eu' });

    expect(request).toHaveBeenCalledWith('/data/wow/ruleset/index', {
      region: 'eu',
      namespace: 'dynamic'
    });
  });
});

describe('getRuleset', () => {
  it('requests a single ruleset under the dynamic namespace', async () => {
    await getRuleset(2);

    expect(request).toHaveBeenCalledWith('/data/wow/ruleset/2', { namespace: 'dynamic' });
  });

  it('forwards caller options alongside the namespace', async () => {
    await getRuleset(2, { region: 'eu' });

    expect(request).toHaveBeenCalledWith('/data/wow/ruleset/2', { region: 'eu', namespace: 'dynamic' });
  });
});

describe('getRulesetAuctionIndex', () => {
  it('requests the auction index with its required trailing slash', async () => {
    await getRulesetAuctionIndex(2);

    expect(request).toHaveBeenCalledWith('/data/wow/ruleset/2/auctions/', { namespace: 'dynamic' });
  });

  it('forwards caller options alongside the namespace', async () => {
    await getRulesetAuctionIndex(2, { region: 'eu' });

    expect(request).toHaveBeenCalledWith('/data/wow/ruleset/2/auctions/', {
      region: 'eu',
      namespace: 'dynamic'
    });
  });
});

describe('getPlayableClassIndex', () => {
  it('requests the class index under the static namespace', async () => {
    await getPlayableClassIndex();

    expect(request).toHaveBeenCalledWith('/data/wow/playable-class/index', { namespace: 'static' });
  });

  it('forwards caller options alongside the namespace', async () => {
    await getPlayableClassIndex({ region: 'eu' });

    expect(request).toHaveBeenCalledWith('/data/wow/playable-class/index', {
      region: 'eu',
      namespace: 'static'
    });
  });
});

describe('getItem', () => {
  it('requests the item document under the static namespace', async () => {
    await getItem(12345);

    expect(request).toHaveBeenCalledWith('/data/wow/item/12345', { namespace: 'static' });
  });

  it('forwards caller options alongside the namespace', async () => {
    await getItem(12345, { region: 'eu' });

    expect(request).toHaveBeenCalledWith('/data/wow/item/12345', { region: 'eu', namespace: 'static' });
  });
});

describe('getItemMedia', () => {
  it('requests item media under the static namespace', async () => {
    await getItemMedia(12345);

    expect(request).toHaveBeenCalledWith('/data/wow/media/item/12345', { namespace: 'static' });
  });

  it('forwards caller options alongside the namespace', async () => {
    await getItemMedia(12345, { region: 'eu' });

    expect(request).toHaveBeenCalledWith('/data/wow/media/item/12345', {
      region: 'eu',
      namespace: 'static'
    });
  });
});

describe('searchItems', () => {
  it('falls back to the real config and its locale when none is given', async () => {
    await searchItems('Thunderfury');

    const [path, options] = request.mock.calls[0];
    expect(path).toBe('/data/wow/search/item');
    expect(options.namespace).toBe('static');
    // BLIZZARD_LOCALE is pinned to en_US by jest.setup.js.
    expect(options.searchParams['name.en_US']).toBe('Thunderfury');
    expect(options.searchParams.orderby).toBe('id');
    expect(options.searchParams._page).toBe(1);
  });

  it('uses a caller-supplied config and locale instead of reading the real one', async () => {
    const config = { blizzard: { locale: 'de_DE' } };

    await searchItems('Thunderfury', { config, locale: 'fr_FR' });

    const [, options] = request.mock.calls[0];
    expect(options.searchParams['name.fr_FR']).toBe('Thunderfury');
    expect(options.config).toBe(config);
  });

  it('derives the locale from a caller-supplied config when no locale is given', async () => {
    const config = { blizzard: { locale: 'de_DE' } };

    await searchItems('Thunderfury', { config });

    const [, options] = request.mock.calls[0];
    expect(options.searchParams['name.de_DE']).toBe('Thunderfury');
  });

  it('lets caller-supplied search params override the defaults', async () => {
    await searchItems('Thunderfury', { searchParams: { orderby: 'name', _page: 2 } });

    const [, options] = request.mock.calls[0];
    expect(options.searchParams.orderby).toBe('name');
    expect(options.searchParams._page).toBe(2);
    expect(options.searchParams['name.en_US']).toBe('Thunderfury');
  });
});
