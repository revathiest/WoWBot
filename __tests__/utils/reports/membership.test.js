const {
  countByDiscord,
  fetchPresentUserIds,
  splitByDiscord
} = require('../../../utils/reports/membership');
const { characterKey } = require('../../../utils/reports/links');

const REALM = 'nightslayer';

function owners(entries) {
  return new Map(entries.map(([name, userId]) => [characterKey({ name, realm: REALM }), userId]));
}

function member(name, level = 70) {
  return { name, level, className: 'Rogue' };
}

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

describe('splitByDiscord', () => {
  it('counts a linked character whose owner is present as on Discord', () => {
    const split = splitByDiscord(
      [member('Butud')],
      REALM,
      owners([['Butud', 'u1']]),
      new Set(['u1'])
    );

    expect(split.onDiscord.map(m => m.name)).toEqual(['Butud']);
    expect(split.left).toEqual([]);
    expect(split.unlinked).toEqual([]);
  });

  it('separates a linked character whose owner has left', () => {
    // Different follow-up from "never linked", so they are not merged.
    const split = splitByDiscord(
      [member('Butud')],
      REALM,
      owners([['Butud', 'u1']]),
      new Set(['someone-else'])
    );

    expect(split.left.map(m => m.name)).toEqual(['Butud']);
    expect(split.onDiscord).toEqual([]);
  });

  it('treats an unclaimed character as unlinked', () => {
    const split = splitByDiscord([member('Stranger')], REALM, new Map(), new Set());

    expect(split.unlinked.map(m => m.name)).toEqual(['Stranger']);
  });

  it('takes a link at face value when the member list could not be read', () => {
    // Otherwise a failed fetch would report the entire guild as having left.
    const split = splitByDiscord([member('Butud')], REALM, owners([['Butud', 'u1']]), null);

    expect(split.onDiscord.map(m => m.name)).toEqual(['Butud']);
    expect(split.left).toEqual([]);
  });

  it('matches a typed realm name against the roster slug', () => {
    const byName = new Map([[characterKey({ name: 'Butud', realm: 'Area 52' }), 'u1']]);
    const split = splitByDiscord([member('Butud')], 'area-52', byName, null);

    expect(split.onDiscord).toHaveLength(1);
  });

  it('carries the owner id through for the breakdown', () => {
    const split = splitByDiscord([member('Butud')], REALM, owners([['Butud', 'u1']]), null);
    expect(split.onDiscord[0].userId).toBe('u1');
  });

  it('handles an empty roster', () => {
    expect(splitByDiscord([], REALM, new Map(), null)).toEqual({
      onDiscord: [],
      left: [],
      unlinked: []
    });
  });
});

describe('countByDiscord', () => {
  it('counts both kinds of absence as "not on Discord"', () => {
    const split = {
      onDiscord: [member('A')],
      left: [member('B')],
      unlinked: [member('C'), member('D')]
    };

    expect(countByDiscord(split)).toEqual({
      onDiscord: 1,
      notOnDiscord: 3,
      left: 1,
      unlinked: 2,
      total: 4
    });
  });

  it('is all zeroes for an empty guild', () => {
    expect(countByDiscord({ onDiscord: [], left: [], unlinked: [] })).toMatchObject({
      onDiscord: 0,
      notOnDiscord: 0,
      total: 0
    });
  });
});

describe('fetchPresentUserIds', () => {
  it('returns every member id', async () => {
    const guild = { id: 'g1', members: { fetch: jest.fn(async () => new Map([['u1', {}], ['u2', {}]])) } };

    expect([...(await fetchPresentUserIds(guild))].sort()).toEqual(['u1', 'u2']);
  });

  it('returns null rather than an empty set when the fetch fails', async () => {
    // An empty set would mean "nobody is here", and the report would claim the
    // whole guild had left Discord.
    const guild = { id: 'g1', members: { fetch: jest.fn(async () => { throw new Error('Missing Intents'); }) } };

    expect(await fetchPresentUserIds(guild)).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });
});
