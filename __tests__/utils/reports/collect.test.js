jest.mock('../../../utils/blizzard/gameData');
jest.mock('../../../utils/blizzard/guild');
jest.mock('../../../utils/blizzard/realms');

// Only the endpoint calls are mocked. Automocking the whole module would turn
// BRACKETS into an empty array, and every bracket loop would quietly do nothing.
jest.mock('../../../utils/blizzard/pvp', () => ({
  ...jest.requireActual('../../../utils/blizzard/pvp'),
  getCharacterPvpSummary: jest.fn(),
  getCurrentSeasonId: jest.fn(),
  getLeaderboard: jest.fn()
}));

const { getPlayableClassIndex } = require('../../../utils/blizzard/gameData');
const { getGuildRoster, slugifyGuild } = require('../../../utils/blizzard/guild');
const { getCharacterPvpSummary, getCurrentSeasonId, getLeaderboard } = require('../../../utils/blizzard/pvp');
const { resolveRealm } = require('../../../utils/blizzard/realms');

const {
  MAX_KILL_LOOKUPS,
  clearClassIndexCache,
  collectArena,
  collectKills,
  collectSnapshot,
  getClassNames,
  mapWithConcurrency,
  readRoster
} = require('../../../utils/reports/collect');

const GUILD = { name: 'Apex', realm: 'Nightslayer', region: 'us', game: 'anniversary' };

/** A roster entry shaped like the real Anniversary payload: class id, no name. */
function member(name, { level = 70, rank = 5, classId = 4 } = {}) {
  return {
    character: {
      name,
      level,
      realm: { slug: 'nightslayer' },
      playable_class: { id: classId }
    },
    rank
  };
}

function ladderEntry(name, { rating = 1800, rank = 40, won = 10, lost = 5, slug = 'nightslayer' } = {}) {
  return {
    character: { name, realm: { slug } },
    rank,
    rating,
    season_match_statistics: { won, lost }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearClassIndexCache();
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  resolveRealm.mockResolvedValue({ slug: 'nightslayer', name: 'Nightslayer', resolved: true });
  slugifyGuild.mockReturnValue('apex');
  getPlayableClassIndex.mockResolvedValue({ classes: [{ id: 4, name: 'Rogue' }] });
  getGuildRoster.mockResolvedValue({
    guild: { name: 'Apex', realm: { name: 'Nightslayer' }, faction: { name: 'Horde' } },
    members: [member('Butud')]
  });
  getCurrentSeasonId.mockResolvedValue(3);
  getLeaderboard.mockResolvedValue([]);
  getCharacterPvpSummary.mockResolvedValue({ honorable_kills: 500 });
});

afterEach(() => jest.restoreAllMocks());

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const result = await mapWithConcurrency([30, 10, 20], 3, async ms => {
      await new Promise(resolve => setTimeout(resolve, ms / 10));
      return ms;
    });

    expect(result).toEqual([30, 10, 20]);
  });

  it('never runs more than the limit at once', async () => {
    let active = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active -= 1;
    });

    expect(peak).toBeLessThanOrEqual(4);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe('getClassNames', () => {
  it('resolves the ids that Anniversary rosters carry instead of names', async () => {
    const names = await getClassNames({ region: 'us', game: 'anniversary' });
    expect(names.get(4)).toBe('Rogue');
  });

  it('caches, so one report does not refetch a static index', async () => {
    await getClassNames({ region: 'us', game: 'anniversary' });
    await getClassNames({ region: 'us', game: 'anniversary' });

    expect(getPlayableClassIndex).toHaveBeenCalledTimes(1);
  });

  it('degrades to no class names rather than failing the report', async () => {
    getPlayableClassIndex.mockRejectedValue(new Error('503'));

    expect((await getClassNames({ region: 'us', game: 'anniversary' })).size).toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('readRoster', () => {
  it('resolves a class id through the index', () => {
    const read = readRoster({ members: [member('Butud')] }, new Map([[4, 'Rogue']]));
    expect(read).toEqual([{ name: 'Butud', level: 70, rank: 5, className: 'Rogue' }]);
  });

  it('prefers a class name when retail supplies one directly', () => {
    const entry = member('Butud');
    entry.character.playable_class.name = 'Rogue';

    expect(readRoster({ members: [entry] }, new Map()).at(0).className).toBe('Rogue');
  });

  it('tolerates an unknown class id', () => {
    expect(readRoster({ members: [member('Butud', { classId: 99 })] }, new Map()).at(0).className).toBeNull();
  });

  it('drops entries with no name', () => {
    expect(readRoster({ members: [{ character: {}, rank: 1 }] }, new Map())).toEqual([]);
  });

  it('tolerates an empty payload', () => {
    expect(readRoster(null, new Map())).toEqual([]);
  });
});

describe('collectArena', () => {
  it('keeps only the tracked realm, since a ladder is region-wide', async () => {
    getLeaderboard.mockResolvedValue([
      ladderEntry('Butud'),
      ladderEntry('Stranger', { slug: 'dreamscythe' })
    ]);

    const { standings } = await collectArena({
      region: 'us',
      game: 'anniversary',
      realmSlug: 'nightslayer',
      brackets: ['2v2']
    });

    expect([...standings.keys()]).toEqual(['butud']);
  });

  it('merges a character ranked in several brackets', async () => {
    getLeaderboard.mockImplementation(async (_season, bracket) => [
      ladderEntry('Butud', { rating: bracket === '2v2' ? 1800 : 1900 })
    ]);

    const { standings } = await collectArena({
      region: 'us',
      game: 'anniversary',
      realmSlug: 'nightslayer',
      brackets: ['2v2', '3v3']
    });

    expect(standings.get('butud')).toEqual({
      '2v2': { rating: 1800, rank: 40, won: 10, lost: 5 },
      '3v3': { rating: 1900, rank: 40, won: 10, lost: 5 }
    });
  });

  it('returns nothing when the game version has no season', async () => {
    getCurrentSeasonId.mockResolvedValue(null);

    const result = await collectArena({ region: 'us', game: 'classic-era', realmSlug: 'x' });

    expect(result).toEqual({ seasonId: null, standings: new Map() });
    expect(getLeaderboard).not.toHaveBeenCalled();
  });

  it('skips a bracket that fails rather than losing the others', async () => {
    getLeaderboard.mockImplementation(async (_season, bracket) => {
      if (bracket === '2v2') throw new Error('500');
      return [ladderEntry('Butud')];
    });

    const { standings } = await collectArena({
      region: 'us',
      game: 'anniversary',
      realmSlug: 'nightslayer',
      brackets: ['2v2', '3v3']
    });

    expect(Object.keys(standings.get('butud'))).toEqual(['3v3']);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('collectKills', () => {
  const members = [{ name: 'Butud', level: 70 }];

  it('reads honorable kills per member', async () => {
    const { kills } = await collectKills(members, {
      region: 'us',
      game: 'anniversary',
      realmSlug: 'nightslayer'
    });

    expect(kills.get('butud')).toBe(500);
  });

  it('counts a 404 as missing, not as a failure', async () => {
    // Bank alts and unpublished profiles 404 routinely — 23 of 240 in a real
    // guild — so treating them as errors would warn on every report.
    const notFound = Object.assign(new Error('Not found.'), { status: 404 });
    getCharacterPvpSummary.mockRejectedValue(notFound);

    const result = await collectKills(members, {
      region: 'us',
      game: 'anniversary',
      realmSlug: 'nightslayer'
    });

    expect(result).toMatchObject({ missing: 1, failures: 0 });
  });

  it('counts anything else as a real failure', async () => {
    getCharacterPvpSummary.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));

    const result = await collectKills(members, {
      region: 'us',
      game: 'anniversary',
      realmSlug: 'nightslayer'
    });

    expect(result).toMatchObject({ missing: 0, failures: 1 });
  });

  it('looks up the highest levels first, so a capped guild still covers its raiders', async () => {
    const many = Array.from({ length: MAX_KILL_LOOKUPS + 10 }, (_, i) => ({
      name: `Alt${i}`,
      level: i
    }));

    const result = await collectKills(many, {
      region: 'us',
      game: 'anniversary',
      realmSlug: 'nightslayer',
      concurrency: 50
    });

    expect(result.capped).toBe(true);
    expect(result.attempted).toBe(MAX_KILL_LOOKUPS);
    // The level-0 alts are the ones that got cut.
    expect(result.kills.has('alt0')).toBe(false);
    expect(result.kills.has(`alt${MAX_KILL_LOOKUPS + 9}`)).toBe(true);
  });

  it('reports progress so a long run is not silent', async () => {
    const onProgress = jest.fn();
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `Alt${i}`, level: 70 }));

    await collectKills(many, {
      region: 'us',
      game: 'anniversary',
      realmSlug: 'nightslayer',
      onProgress
    });

    expect(onProgress).toHaveBeenCalledWith({ done: 25, total: 50 });
  });
});

describe('collectSnapshot', () => {
  it('assembles roster, arena, and kills into one snapshot', async () => {
    getLeaderboard.mockImplementation(async (_s, bracket) =>
      bracket === '2v2' ? [ladderEntry('Butud')] : []
    );

    const { snapshot } = await collectSnapshot(GUILD);

    expect(snapshot.members.butud).toMatchObject({
      name: 'Butud',
      level: 70,
      className: 'Rogue',
      rank: 5,
      kills: 500,
      brackets: { '2v2': { rating: 1800, rank: 40, won: 10, lost: 5 } }
    });
  });

  it('records the guild identity the report is titled with', async () => {
    const { snapshot } = await collectSnapshot(GUILD, { capturedAt: 1234 });

    expect(snapshot.guild).toMatchObject({
      name: 'Apex',
      realm: 'Nightslayer',
      realmSlug: 'nightslayer',
      faction: 'Horde',
      seasonId: 3
    });
    expect(snapshot.capturedAt).toBe(1234);
  });

  it('names the slugs it tried when a guild does not exist', async () => {
    // There is no guild index to suggest names from, so the slugs are the only
    // help available.
    const notFound = Object.assign(new Error('Not found.'), { status: 404 });
    getGuildRoster.mockRejectedValue(notFound);

    await expect(collectSnapshot(GUILD)).rejects.toMatchObject({
      realmSlug: 'nightslayer',
      guildSlug: 'apex'
    });
  });

  it('can skip the expensive kill pass', async () => {
    const { snapshot } = await collectSnapshot(GUILD, { includeKills: false });

    expect(getCharacterPvpSummary).not.toHaveBeenCalled();
    expect(snapshot.members.butud.kills).toBeNull();
  });

  it('warns when there is no PvP season to report on', async () => {
    getCurrentSeasonId.mockResolvedValue(null);

    const { warnings } = await collectSnapshot(GUILD);

    expect(warnings).toEqual([expect.stringContaining('No PvP season')]);
  });

  it('warns about real lookup errors but not about routine 404s', async () => {
    getCharacterPvpSummary.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    const { warnings } = await collectSnapshot(GUILD);

    expect(warnings).toEqual([expect.stringContaining('errored')]);
  });

  it('produces no warnings when every member simply has no PvP summary', async () => {
    getCharacterPvpSummary.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));

    const { warnings } = await collectSnapshot(GUILD);

    expect(warnings).toEqual([]);
  });
});
