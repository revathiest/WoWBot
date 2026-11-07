jest.mock('../../../utils/blizzard/gameData');
jest.mock('../../../utils/blizzard/guild');
jest.mock('../../../utils/blizzard/profile', () => ({
  ...jest.requireActual('../../../utils/blizzard/profile'),
  getCharacterPvpSummary: jest.fn()
}));

const { getPlayableClassIndex } = require('../../../utils/blizzard/gameData');
const { getGuildRoster, slugifyGuild } = require('../../../utils/blizzard/guild');
const { getCharacterPvpSummary } = require('../../../utils/blizzard/profile');

const {
  MAX_KILL_LOOKUPS,
  clearClassIndexCache,
  collectKills,
  collectSnapshot,
  getClassNames,
  mapWithConcurrency,
  readRoster
} = require('../../../utils/reports/collect');

const GUILD = { name: 'Circle of Lore', region: 'eu' };

/** A roster entry shaped like the real Forever payload: class id, no name. */
function member(name, surname, { level = 10, rank = 5, classId = 4 } = {}) {
  return {
    character: { name, surname, level, playable_class: { id: classId } },
    rank
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearClassIndexCache();
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  slugifyGuild.mockReturnValue('circle-of-lore');
  getPlayableClassIndex.mockResolvedValue({ classes: [{ id: 4, name: 'Paladin' }] });
  getGuildRoster.mockResolvedValue({
    guild: { name: 'Circle of Lore', faction: { name: 'Alliance' } },
    members: [member('Judgement', 'Judy')]
  });
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
  it('resolves the ids that rosters carry instead of names', async () => {
    const names = await getClassNames({ region: 'eu' });
    expect(names.get(4)).toBe('Paladin');
  });

  it('caches, so one report does not refetch a static index', async () => {
    await getClassNames({ region: 'eu' });
    await getClassNames({ region: 'eu' });

    expect(getPlayableClassIndex).toHaveBeenCalledTimes(1);
  });

  it('degrades to no class names rather than failing the report', async () => {
    getPlayableClassIndex.mockRejectedValue(new Error('503'));

    expect((await getClassNames({ region: 'eu' })).size).toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('readRoster', () => {
  it('resolves a class id through the index', () => {
    const read = readRoster({ members: [member('Judgement', 'Judy')] }, new Map([[4, 'Paladin']]));

    expect(read).toEqual([
      { name: 'Judgement', surname: 'Judy', level: 10, rank: 5, className: 'Paladin' }
    ]);
  });

  it('prefers a class name when the roster supplies one directly', () => {
    const entry = member('Judgement', 'Judy');
    entry.character.playable_class.name = 'Paladin';

    expect(readRoster({ members: [entry] }, new Map()).at(0).className).toBe('Paladin');
  });

  it('tolerates an unknown class id', () => {
    expect(
      readRoster({ members: [member('Judgement', 'Judy', { classId: 99 })] }, new Map()).at(0).className
    ).toBeNull();
  });

  it('drops entries with no name', () => {
    expect(readRoster({ members: [{ character: {}, rank: 1 }] }, new Map())).toEqual([]);
  });

  it('tolerates an empty payload', () => {
    expect(readRoster(null, new Map())).toEqual([]);
  });
});

describe('collectKills', () => {
  const members = [{ name: 'Judgement', surname: 'Judy', level: 10 }];

  it('reads honorable kills per member', async () => {
    const { kills } = await collectKills(members, { region: 'eu' });
    expect(kills.get('judgement-judy')).toBe(500);
  });

  it('counts a member with no surname as missing, since it cannot be addressed', async () => {
    const result = await collectKills([{ name: 'NoSurname', level: 5 }], { region: 'eu' });

    expect(result).toMatchObject({ missing: 1, failures: 0 });
    expect(getCharacterPvpSummary).not.toHaveBeenCalled();
  });

  it('counts a 404 as missing, not as a failure', async () => {
    // Characters below level 10, and those never logged out, 404 routinely —
    // treating them as errors would warn on every report.
    const notFound = Object.assign(new Error('Not found.'), { status: 404 });
    getCharacterPvpSummary.mockRejectedValue(notFound);

    const result = await collectKills(members, { region: 'eu' });

    expect(result).toMatchObject({ missing: 1, failures: 0 });
  });

  it('counts anything else as a real failure', async () => {
    getCharacterPvpSummary.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));

    const result = await collectKills(members, { region: 'eu' });

    expect(result).toMatchObject({ missing: 0, failures: 1 });
  });

  it('looks up the highest levels first, so a capped guild still covers its raiders', async () => {
    const many = Array.from({ length: MAX_KILL_LOOKUPS + 10 }, (_, i) => ({
      name: `Alt${i}`,
      surname: 'Smith',
      level: i
    }));

    const result = await collectKills(many, { region: 'eu', concurrency: 50 });

    expect(result.capped).toBe(true);
    expect(result.attempted).toBe(MAX_KILL_LOOKUPS);
    // The level-0 alts are the ones that got cut.
    expect(result.kills.has('alt0-smith')).toBe(false);
    expect(result.kills.has(`alt${MAX_KILL_LOOKUPS + 9}-smith`)).toBe(true);
  });

  it('reports progress so a long run is not silent', async () => {
    const onProgress = jest.fn();
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `Alt${i}`, surname: 'Smith', level: 10 }));

    await collectKills(many, { region: 'eu', onProgress });

    expect(onProgress).toHaveBeenCalledWith({ done: 25, total: 50 });
  });
});

describe('collectSnapshot', () => {
  it('assembles roster and kills into one snapshot', async () => {
    const { snapshot } = await collectSnapshot(GUILD);

    expect(snapshot.members['judgement-judy']).toMatchObject({
      name: 'Judgement',
      surname: 'Judy',
      level: 10,
      className: 'Paladin',
      rank: 5,
      kills: 500
    });
  });

  it('records the guild identity the report is titled with', async () => {
    const { snapshot } = await collectSnapshot(GUILD, { capturedAt: 1234 });

    expect(snapshot.guild).toMatchObject({ name: 'Circle of Lore', faction: 'Alliance', region: 'eu' });
    expect(snapshot.capturedAt).toBe(1234);
  });

  it('names the slug it tried when a guild does not exist', async () => {
    // There is no guild index to suggest names from, so the slug is the only
    // help available.
    const notFound = Object.assign(new Error('Not found.'), { status: 404 });
    getGuildRoster.mockRejectedValue(notFound);

    await expect(collectSnapshot(GUILD)).rejects.toMatchObject({ guildSlug: 'circle-of-lore' });
  });

  it('can skip the expensive kill pass', async () => {
    const { snapshot } = await collectSnapshot(GUILD, { includeKills: false });

    expect(getCharacterPvpSummary).not.toHaveBeenCalled();
    expect(snapshot.members['judgement-judy'].kills).toBeNull();
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
