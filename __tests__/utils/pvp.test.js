jest.mock('../../utils/blizzard/client', () => ({ request: jest.fn() }));

const { request } = require('../../utils/blizzard/client');
const {
  BRACKETS,
  LEADERBOARD_TTL_MS,
  clearPvpCache,
  findOnLadder,
  getCharacterPvpBracket,
  getCharacterPvpSummary,
  getCurrentSeasonId,
  getLeaderboard
} = require('../../utils/blizzard/pvp');

beforeEach(() => {
  jest.clearAllMocks();
  clearPvpCache();
});

afterEach(() => jest.restoreAllMocks());

const lastCall = () => request.mock.calls[request.mock.calls.length - 1];

const entry = (name, realm, rank, rating) => ({
  rank,
  rating,
  character: { name, realm: { slug: realm } },
  season_match_statistics: { won: 10, lost: 5 }
});

describe('BRACKETS', () => {
  it('lists only the brackets TBC has', () => {
    // The API also advertises retail-only brackets that are empty here.
    expect(BRACKETS).toEqual(['2v2', '3v3', '5v5']);
  });
});

describe('getCurrentSeasonId', () => {
  it('uses the season Blizzard marks current, never a hardcoded one', async () => {
    request.mockResolvedValue({ seasons: [{ id: 1 }, { id: 2 }, { id: 3 }], current_season: { id: 3 } });

    await expect(getCurrentSeasonId({ region: 'us' })).resolves.toBe(3);
  });

  it('falls back to the highest listed season', async () => {
    request.mockResolvedValue({ seasons: [{ id: 1 }, { id: 5 }, { id: 3 }] });

    await expect(getCurrentSeasonId({})).resolves.toBe(5);
  });

  it('returns null when there are no seasons', async () => {
    request.mockResolvedValue({ seasons: [] });

    await expect(getCurrentSeasonId({})).resolves.toBeNull();
  });
});

describe('getLeaderboard', () => {
  it('requests the right path and namespace', async () => {
    request.mockResolvedValue({ entries: [] });

    await getLeaderboard(3, '3v3', { region: 'us', game: 'anniversary' });

    const [path, options] = lastCall();
    expect(path).toBe('/data/wow/pvp-season/3/pvp-leaderboard/3v3');
    expect(options.namespace).toBe('dynamic');
    expect(options.game).toBe('anniversary');
  });

  it('caches, because a ladder is thousands of entries', async () => {
    request.mockResolvedValue({ entries: [entry('A', 'r', 1, 2000)] });

    await getLeaderboard(3, '3v3', { region: 'us', game: 'anniversary' });
    await getLeaderboard(3, '3v3', { region: 'us', game: 'anniversary' });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('caches each bracket, region, and game separately', async () => {
    request.mockResolvedValue({ entries: [] });

    await getLeaderboard(3, '2v2', { region: 'us', game: 'anniversary' });
    await getLeaderboard(3, '3v3', { region: 'us', game: 'anniversary' });
    await getLeaderboard(3, '3v3', { region: 'eu', game: 'anniversary' });
    await getLeaderboard(3, '3v3', { region: 'us', game: 'retail' });

    expect(request).toHaveBeenCalledTimes(4);
  });

  it('refetches once the cache expires', async () => {
    request.mockResolvedValue({ entries: [] });
    await getLeaderboard(3, '3v3', { region: 'us', game: 'anniversary' });

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + LEADERBOARD_TTL_MS + 1000);
    await getLeaderboard(3, '3v3', { region: 'us', game: 'anniversary' });

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('tolerates a ladder with no entries field', async () => {
    request.mockResolvedValue({});

    await expect(getLeaderboard(3, '3v3', {})).resolves.toEqual([]);
  });
});

describe('findOnLadder', () => {
  const entries = [
    entry('Mosquietos', 'nightslayer', 1, 2341),
    entry('Zuggbeard', 'dreamscythe', 40, 1800)
  ];

  it('finds a character case-insensitively on the right realm', () => {
    const { entry: found, total } = findOnLadder(entries, 'mosquietos', 'nightslayer');

    expect(found.rank).toBe(1);
    expect(total).toBe(2);
  });

  it('does not match the same name on another realm', () => {
    expect(findOnLadder(entries, 'Zuggbeard', 'nightslayer').entry).toBeNull();
  });

  it('returns null for someone unranked', () => {
    expect(findOnLadder(entries, 'Nobody', 'nightslayer').entry).toBeNull();
  });

  it('reports the ladder size even on a miss', () => {
    expect(findOnLadder(entries, 'Nobody').total).toBe(2);
  });
});

describe('character PvP endpoints', () => {
  it('requests the pvp summary from the profile namespace', async () => {
    request.mockResolvedValue({});

    await getCharacterPvpSummary('nightslayer', 'zuggbeard', { region: 'us' });

    const [path, options] = lastCall();
    expect(path).toBe('/profile/wow/character/nightslayer/zuggbeard/pvp-summary');
    expect(options.namespace).toBe('profile');
  });

  it('requests a single bracket', async () => {
    request.mockResolvedValue({});

    await getCharacterPvpBracket('nightslayer', 'zuggbeard', '3v3', {});

    expect(lastCall()[0]).toBe('/profile/wow/character/nightslayer/zuggbeard/pvp-bracket/3v3');
  });
});
