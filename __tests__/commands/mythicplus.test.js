jest.mock('../../utils/blizzard/profile', () => ({
  getMythicKeystoneProfile: jest.fn(),
  getMythicKeystoneSeason: jest.fn()
}));

const {
  getMythicKeystoneProfile,
  getMythicKeystoneSeason
} = require('../../utils/blizzard/profile');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const command = require('../../commands/wow/mythicplus');
const { createInteraction, field, replyEmbed, replyPayload } = require('../helpers/interaction');

const run = (dungeon, level, { timed = true, duration = 1800000, rating = 150.5 } = {}) => ({
  dungeon: { name: dungeon },
  keystone_level: level,
  is_completed_within_time: timed,
  duration,
  mythic_rating: { rating },
  completed_timestamp: 1700000000000
});

function interaction(overrides = {}) {
  return createInteraction({
    commandName: 'mythicplus',
    options: { character: 'Thrall', realm: 'Area 52', ...overrides }
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  getMythicKeystoneProfile.mockResolvedValue({
    current_period: { best_runs: [run('The Necrotic Wake', 10)] },
    current_mythic_rating: { rating: 2100.4, color: { r: 163, g: 53, b: 238 } },
    seasons: [{ id: 13 }, { id: 14 }]
  });

  getMythicKeystoneSeason.mockResolvedValue({
    best_runs: [
      run('Ara-Kara', 12),
      run('City of Threads', 15, { rating: 200 }),
      run('Mists of Tirna Scithe', 8, { timed: false, duration: 2100000 })
    ],
    mythic_rating: { rating: 2500.6, color: { r: 255, g: 128, b: 0 } }
  });
});

afterEach(() => jest.restoreAllMocks());

describe('/mythicplus definition', () => {
  it('requires a character and realm', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('mythicplus');
    expect(json.options.map(option => [option.name, option.required])).toEqual([
      ['character', true],
      ['realm', true],
      ['region', false]
    ]);
  });
});

describe('ratingColor', () => {
  it('packs Blizzard RGB components into a Discord colour', () => {
    expect(command.ratingColor({ color: { r: 163, g: 53, b: 238 } })).toBe(0xa335ee);
  });

  it('falls back when colour data is absent', () => {
    expect(command.ratingColor(null)).toBe(0x5865f2);
    expect(command.ratingColor({ color: { r: 1 } })).toBe(0x5865f2);
  });
});

describe('formatRun', () => {
  it('marks timed runs and shows duration plus score', () => {
    expect(command.formatRun(run('Ara-Kara', 12))).toBe('✅ **+12** Ara-Kara — 30:00 • 150.5');
  });

  it('marks depleted runs differently', () => {
    expect(command.formatRun(run('Ara-Kara', 12, { timed: false }))).toContain('⏳');
  });

  it('handles a run with missing detail', () => {
    expect(command.formatRun({})).toBe('⏳ **+?** Unknown dungeon — 0:00');
  });
});

describe('/mythicplus execute', () => {
  it('prefers the latest season and lists runs strongest first', async () => {
    const target = interaction();

    await command.execute(target);

    expect(getMythicKeystoneSeason).toHaveBeenCalledWith(
      'Area 52',
      'Thrall',
      14,
      expect.objectContaining({ region: 'us' })
    );

    const embed = replyEmbed(target);
    expect(field(embed, 'Mythic+ Rating').value).toBe('2500.6');
    expect(field(embed, 'Season').value).toBe('14');

    const lines = embed.description.split('\n');
    expect(lines[0]).toContain('+15');
    expect(lines[1]).toContain('+12');
    expect(lines[2]).toContain('+8');
  });

  it('falls back to the current period when the season call fails', async () => {
    getMythicKeystoneSeason.mockRejectedValue(new Error('season down'));
    const target = interaction();

    await command.execute(target);

    const embed = replyEmbed(target);
    expect(embed.description).toContain('The Necrotic Wake');
    expect(field(embed, 'Mythic+ Rating').value).toBe('2100.4');
  });

  it('handles a character with no seasons recorded', async () => {
    getMythicKeystoneProfile.mockResolvedValue({ current_period: { best_runs: [] } });
    const target = interaction();

    await command.execute(target);

    expect(getMythicKeystoneSeason).not.toHaveBeenCalled();
    const embed = replyEmbed(target);
    expect(embed.description).toContain('No completed keystone runs');
    expect(field(embed, 'Mythic+ Rating').value).toBe('Unrated');
  });

  it('explains a 404 as missing Mythic+ data', async () => {
    getMythicKeystoneProfile.mockRejectedValue(new BlizzardApiError('Not found.', { status: 404 }));
    const target = interaction();

    await command.execute(target);

    expect(replyPayload(target)).toContain('No Mythic+ data');
  });

  it('rethrows other failures', async () => {
    getMythicKeystoneProfile.mockRejectedValue(new BlizzardApiError('boom', { status: 500 }));

    await expect(command.execute(interaction())).rejects.toThrow('boom');
  });

  it('caps the number of runs shown', () => {
    const runs = Array.from({ length: 12 }, (_, index) => run(`Dungeon ${index}`, index + 2));

    const embed = command
      .buildEmbed({ runs, rating: null, region: 'us', realmSlug: 'area-52', characterName: 'X' })
      .toJSON();

    expect(embed.description.split('\n')).toHaveLength(8);
  });
});
