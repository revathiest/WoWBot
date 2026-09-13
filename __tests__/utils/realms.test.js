jest.mock('../../utils/blizzard/gameData', () => ({
  getRealmIndex: jest.fn()
}));

const { getRealmIndex } = require('../../utils/blizzard/gameData');
const {
  CACHE_TTL_MS,
  clearRealmCache,
  findRealmGames,
  findRealm,
  getPlayableRealms,
  getRealms,
  resolveRealm,
  searchRealms
} = require('../../utils/blizzard/realms');

// Real name/slug pairs, including the shapes that broke the old hand-rolled slug.
const INDEX = {
  realms: [
    { id: 1, name: 'Area 52', slug: 'area-52' },
    { id: 2, name: 'Azjol-Nerub', slug: 'azjolnerub' },
    { id: 3, name: "Mal'Ganis", slug: 'malganis' },
    { id: 4, name: 'Marécage de Zangar', slug: 'marécage-de-zangar' },
    { id: 5, name: 'Aegwynn', slug: 'aegwynn' },
    { id: 6, name: 'US1A2-INST', slug: 'us1a2inst' },
    { id: 7, name: 'US2 CWOW CSI 80', slug: 'us2-cwow-csi-80' },
    { id: 8, name: 'zzz_RDB EU', slug: 'zzzrdb-eu' },
    { id: 9, name: 'PROGWOW US1 Web', slug: 'progwow-us1-web' }
  ]
};

beforeEach(() => {
  jest.clearAllMocks();
  clearRealmCache();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  getRealmIndex.mockResolvedValue(INDEX);
});

afterEach(() => jest.restoreAllMocks());

describe('getRealms', () => {
  it('returns realms sorted by name', async () => {
    const realms = await getRealms({ region: 'us', game: 'retail' });

    expect(realms.map(r => r.name)).toEqual([
      'Aegwynn',
      'Area 52',
      'Azjol-Nerub',
      "Mal'Ganis",
      'Marécage de Zangar',
      'PROGWOW US1 Web',
      'US1A2-INST',
      'US2 CWOW CSI 80',
      'zzz_RDB EU'
    ]);
  });

  it('flags internal realms without discarding them', async () => {
    const realms = await getRealms({ region: 'us', game: 'retail' });
    const internal = realms.filter(r => r.internal).map(r => r.name);

    // PROGWOW entries appear on the Anniversary namespace and are not playable.
    expect(internal).toEqual(['PROGWOW US1 Web', 'US1A2-INST', 'US2 CWOW CSI 80', 'zzz_RDB EU']);
  });

  it('caches per region and game', async () => {
    await getRealms({ region: 'us', game: 'retail' });
    await getRealms({ region: 'us', game: 'retail' });
    expect(getRealmIndex).toHaveBeenCalledTimes(1);

    // A different game is a different list, so it must be fetched separately.
    await getRealms({ region: 'us', game: 'classic' });
    expect(getRealmIndex).toHaveBeenCalledTimes(2);

    await getRealms({ region: 'eu', game: 'retail' });
    expect(getRealmIndex).toHaveBeenCalledTimes(3);
  });

  it('passes region and game through to the API', async () => {
    await getRealms({ region: 'eu', game: 'classic' });

    expect(getRealmIndex).toHaveBeenCalledWith(expect.objectContaining({
      region: 'eu',
      game: 'classic'
    }));
  });

  it('refetches once the cache expires', async () => {
    await getRealms({ region: 'us', game: 'retail' });

    const later = Date.now() + CACHE_TTL_MS + 1000;
    jest.spyOn(Date, 'now').mockReturnValue(later);

    await getRealms({ region: 'us', game: 'retail' });
    expect(getRealmIndex).toHaveBeenCalledTimes(2);
  });

  it('tolerates an index with no realms', async () => {
    getRealmIndex.mockResolvedValue({});
    expect(await getRealms({ region: 'us', game: 'retail' })).toEqual([]);
  });
});

describe('getPlayableRealms', () => {
  it('drops Blizzard internal and test realms', async () => {
    const realms = await getPlayableRealms({ region: 'us', game: 'retail' });

    expect(realms.map(r => r.name)).toEqual([
      'Aegwynn',
      'Area 52',
      'Azjol-Nerub',
      "Mal'Ganis",
      'Marécage de Zangar'
    ]);
  });
});

describe('findRealm', () => {
  const realms = INDEX.realms.map(r => ({ ...r, internal: false }));

  it.each([
    ['Azjol-Nerub', 'azjolnerub'],
    ['azjol nerub', 'azjolnerub'],
    ['AZJOLNERUB', 'azjolnerub'],
    ['area 52', 'area-52'],
    ['Area-52', 'area-52'],
    ["Mal'Ganis", 'malganis'],
    ['malganis', 'malganis'],
    ['Marecage de Zangar', 'marécage-de-zangar']
  ])('matches %s to %s', (input, slug) => {
    expect(findRealm(realms, input).slug).toBe(slug);
  });

  it('returns null for an unknown or empty realm', () => {
    expect(findRealm(realms, 'Nonsense')).toBeNull();
    expect(findRealm(realms, '')).toBeNull();
  });
});

describe('searchRealms', () => {
  const realms = INDEX.realms.map(r => ({ ...r, internal: false }));

  it('matches on a substring of the name', () => {
    expect(searchRealms(realms, 'Area').map(r => r.name)).toEqual(['Area 52']);
    expect(searchRealms(realms, 'nerub').map(r => r.name)).toEqual(['Azjol-Nerub']);
  });

  it('ignores punctuation and accents while searching', () => {
    expect(searchRealms(realms, 'marecage').map(r => r.slug)).toEqual(['marécage-de-zangar']);
  });

  it('returns everything for an empty query', () => {
    expect(searchRealms(realms, '')).toHaveLength(realms.length);
  });
});

describe('findRealmGames', () => {
  it('reports which game versions contain a realm', async () => {
    // Nightslayer exists only on the Anniversary namespace.
    getRealmIndex.mockImplementation(async ({ game }) =>
      game === 'anniversary'
        ? { realms: [{ id: 6065, name: 'Nightslayer', slug: 'nightslayer' }] }
        : INDEX
    );

    const matches = await findRealmGames('Nightslayer', { region: 'us' });

    expect(matches.map(m => m.game)).toEqual(['anniversary']);
    expect(matches[0].label).toBe('TBC Anniversary');
    expect(matches[0].realm.slug).toBe('nightslayer');
  });

  it('skips the version already being searched', async () => {
    const matches = await findRealmGames('Area 52', { region: 'us', exclude: 'retail' });

    expect(matches.some(m => m.game === 'retail')).toBe(false);
  });

  it('returns nothing for a realm that exists nowhere', async () => {
    expect(await findRealmGames('Nonsense', { region: 'us' })).toEqual([]);
  });

  it('ignores versions whose index cannot be read', async () => {
    getRealmIndex.mockImplementation(async ({ game }) => {
      if (game === 'retail') return INDEX;
      throw new Error('API down');
    });

    const matches = await findRealmGames('Area 52', { region: 'us' });

    expect(matches.map(m => m.game)).toEqual(['retail']);
  });
});

describe('resolveRealm', () => {
  it('returns the real slug for a known realm', async () => {
    // The whole point: "Azjol-Nerub" must not become "azjol-nerub".
    await expect(resolveRealm('Azjol-Nerub', { region: 'us', game: 'retail' })).resolves.toEqual({
      slug: 'azjolnerub',
      name: 'Azjol-Nerub',
      resolved: true
    });
  });

  it('falls back to a derived slug when the realm is unknown', async () => {
    const result = await resolveRealm('Nonsense Realm', { region: 'us', game: 'retail' });

    expect(result).toEqual({ slug: 'nonsense-realm', name: 'Nonsense Realm', resolved: false });
  });

  it('degrades to a derived slug when the index cannot be read', async () => {
    getRealmIndex.mockRejectedValue(new Error('API down'));

    const result = await resolveRealm('Area 52', { region: 'us', game: 'retail' });

    expect(result).toEqual({ slug: 'area-52', name: 'Area 52', resolved: false });
    expect(console.warn).toHaveBeenCalled();
  });
});
