jest.mock('../../utils/blizzard/gameData', () => ({
  getRuleset: jest.fn(),
  getRulesetIndex: jest.fn()
}));

const { getRuleset, getRulesetIndex } = require('../../utils/blizzard/gameData');
const {
  CACHE_TTL_MS,
  clearRulesetCache,
  findRuleset,
  getRulesets,
  idsFromIndex,
  resolveRuleset,
  searchRulesets
} = require('../../utils/blizzard/rulesets');

// The real index: ids only, no names and no statuses. That shape is the reason
// listing rulesets costs a request each.
const INDEX = {
  rulesets: [
    { key: { href: 'https://eu.api.blizzard.com/data/wow/ruleset/1' }, id: 1 },
    { key: { href: 'https://eu.api.blizzard.com/data/wow/ruleset/15' }, id: 15 },
    { key: { href: 'https://eu.api.blizzard.com/data/wow/ruleset/3' }, id: 3 },
    { key: { href: 'https://eu.api.blizzard.com/data/wow/ruleset/2' }, id: 2 }
  ]
};

// The four rulesets Classic Forever actually publishes.
const DOCUMENTS = {
  1: { id: 1, name: 'PvP', status: { type: 'UP', name: 'Up' }, auctions: { href: 'a/1' } },
  2: { id: 2, name: 'Normal', status: { type: 'UP', name: 'Up' }, auctions: { href: 'a/2' } },
  3: { id: 3, name: 'Roleplay', status: { type: 'UP', name: 'Up' }, auctions: { href: 'a/3' } },
  15: {
    id: 15,
    name: 'Roleplay PvP',
    status: { type: 'DOWN', name: 'Down' },
    auctions: { href: 'a/15' }
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  clearRulesetCache();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  getRulesetIndex.mockResolvedValue(INDEX);
  getRuleset.mockImplementation(id => Promise.resolve(DOCUMENTS[id]));
});

afterEach(() => jest.restoreAllMocks());

describe('idsFromIndex', () => {
  it('reads the ids out of an index', () => {
    expect(idsFromIndex(INDEX)).toEqual([1, 15, 3, 2]);
  });

  it('ignores entries with no usable id', () => {
    expect(idsFromIndex({ rulesets: [{ id: 2 }, {}, { id: null }, { id: 'x' }] })).toEqual([2]);
  });

  it('treats a missing index as empty rather than throwing', () => {
    expect(idsFromIndex(null)).toEqual([]);
    expect(idsFromIndex({})).toEqual([]);
  });
});

describe('getRulesets', () => {
  it('assembles the index and the per-ruleset documents, sorted by name', async () => {
    const rulesets = await getRulesets({ region: 'eu', game: 'forever' });

    expect(rulesets.map(ruleset => ruleset.name)).toEqual([
      'Normal',
      'PvP',
      'Roleplay',
      'Roleplay PvP'
    ]);
  });

  it('derives a slug, and carries status and the auction link', async () => {
    const rulesets = await getRulesets({ region: 'eu', game: 'forever' });

    expect(rulesets.find(ruleset => ruleset.id === 15)).toEqual({
      id: 15,
      name: 'Roleplay PvP',
      slug: 'roleplay-pvp',
      status: 'DOWN',
      statusLabel: 'Down',
      auctionsHref: 'a/15'
    });
  });

  it('caches per region and game', async () => {
    await getRulesets({ region: 'eu', game: 'forever' });
    await getRulesets({ region: 'eu', game: 'forever' });

    expect(getRulesetIndex).toHaveBeenCalledTimes(1);

    // A different region is a different list, so it must not reuse the cache.
    await getRulesets({ region: 'us', game: 'forever' });
    expect(getRulesetIndex).toHaveBeenCalledTimes(2);
  });

  it('re-reads once the cache has expired', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    await getRulesets({ region: 'eu', game: 'forever' });
    now.mockReturnValue(1_000 + CACHE_TTL_MS + 1);
    await getRulesets({ region: 'eu', game: 'forever' });

    expect(getRulesetIndex).toHaveBeenCalledTimes(2);
  });

  it('drops a ruleset whose document cannot be read, keeping the rest', async () => {
    // A partial list still answers "which rulesets are there".
    getRuleset.mockImplementation(id =>
      id === 3 ? Promise.reject(new Error('boom')) : Promise.resolve(DOCUMENTS[id])
    );

    const rulesets = await getRulesets({ region: 'eu', game: 'forever' });

    expect(rulesets.map(ruleset => ruleset.id).sort((a, b) => a - b)).toEqual([1, 2, 15]);
    expect(console.warn).toHaveBeenCalled();
  });

  it('returns an empty list when the index has no rulesets', async () => {
    getRulesetIndex.mockResolvedValue({ rulesets: [] });

    expect(await getRulesets({ region: 'eu', game: 'forever' })).toEqual([]);
  });
});

describe('findRuleset', () => {
  const list = [
    { id: 1, name: 'PvP', slug: 'pvp' },
    { id: 2, name: 'Normal', slug: 'normal' },
    { id: 15, name: 'Roleplay PvP', slug: 'roleplay-pvp' }
  ];

  it('matches a numeric id', () => {
    expect(findRuleset(list, '15').name).toBe('Roleplay PvP');
  });

  it('matches a name however it is punctuated or cased', () => {
    expect(findRuleset(list, 'roleplay pvp').id).toBe(15);
    expect(findRuleset(list, 'Roleplay-PvP').id).toBe(15);
    expect(findRuleset(list, 'ROLEPLAYPVP').id).toBe(15);
  });

  it('matches a slug', () => {
    expect(findRuleset(list, 'normal').id).toBe(2);
  });

  it('returns null for no match and for empty input', () => {
    expect(findRuleset(list, 'nope')).toBeNull();
    expect(findRuleset(list, '')).toBeNull();
    expect(findRuleset(list, null)).toBeNull();
  });

  it('falls through to name matching when a number is not an id', () => {
    // "9" is not a ruleset id here, and must not be reported as one.
    expect(findRuleset(list, '9')).toBeNull();
  });
});

describe('searchRulesets', () => {
  const list = [
    { id: 1, name: 'PvP', slug: 'pvp' },
    { id: 2, name: 'Normal', slug: 'normal' },
    { id: 15, name: 'Roleplay PvP', slug: 'roleplay-pvp' }
  ];

  it('matches on a substring', () => {
    expect(searchRulesets(list, 'pvp').map(ruleset => ruleset.id)).toEqual([1, 15]);
  });

  it('returns everything for an empty query', () => {
    expect(searchRulesets(list, '')).toBe(list);
  });
});

describe('resolveRuleset', () => {
  it('resolves what the user typed to a real ruleset', async () => {
    expect((await resolveRuleset('Normal', { region: 'eu', game: 'forever' })).id).toBe(2);
  });

  it('returns null rather than guessing when nothing matches', async () => {
    // Unlike a realm, a ruleset is addressed by numeric id, so there is nothing
    // to derive from the text. Guessing would show another ruleset's data.
    expect(await resolveRuleset('Nonsense', { region: 'eu', game: 'forever' })).toBeNull();
  });

  it('returns null when the index cannot be read at all', async () => {
    getRulesetIndex.mockRejectedValue(new Error('offline'));

    expect(await resolveRuleset('Normal', { region: 'eu', game: 'forever' })).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });
});
