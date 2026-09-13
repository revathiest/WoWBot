jest.mock('../../utils/blizzard/guild', () => {
  const actual = jest.requireActual('../../utils/blizzard/guild');
  return { ...actual, getGuildRoster: jest.fn() };
});

jest.mock('../../utils/blizzard/realms', () => ({
  resolveRealm: jest.fn(async query => ({
    slug: String(query).toLowerCase(),
    name: query,
    resolved: true
  }))
}));

const { getGuildRoster, slugifyGuild } = require('../../utils/blizzard/guild');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const command = require('../../commands/wow/guild');
const { field } = require('../helpers/interaction');

function interaction(options = {}) {
  return {
    options: {
      getString: name => options[name] ?? null,
      getInteger: () => null,
      getBoolean: () => null,
      getSubcommand: () => null,
      getSubcommandGroup: () => null
    },
    deferReply: jest.fn(async () => {}),
    editReply: jest.fn(async () => {})
  };
}

const payload = target => target.editReply.mock.calls[target.editReply.mock.calls.length - 1][0];
const embedOf = target => payload(target).embeds[0].toJSON();

const member = (name, level, rank, className = 'Warrior') => ({
  rank,
  character: { name, level, playable_class: { name: className } }
});

const ROSTER = {
  guild: { name: 'Stoneformed', faction: { name: 'Alliance' }, realm: { name: 'Nightslayer' } },
  members: [
    member('Zuggbeard', 70, 0, 'Warrior'),
    member('Limphammer', 70, 1, 'Paladin'),
    member('Ahhghh', 70, 2, 'Warrior'),
    member('Lowbie', 32, 5, 'Mage')
  ]
};

beforeEach(() => {
  jest.clearAllMocks();
  getGuildRoster.mockResolvedValue(ROSTER);
});

describe('slugifyGuild', () => {
  it('follows the realm slug rule', () => {
    expect(slugifyGuild('Stoneformed')).toBe('stoneformed');
    expect(slugifyGuild('Knights of the Round')).toBe('knights-of-the-round');
    // Punctuation is deleted, not turned into a separator — same as realms.
    expect(slugifyGuild("Knight's Watch")).toBe('knights-watch');
  });
});

describe('levelSpread and classSpread', () => {
  it('counts members per level, highest first', () => {
    expect(command.levelSpread(ROSTER.members)).toEqual([
      [70, 3],
      [32, 1]
    ]);
  });

  it('counts members per class, largest first', () => {
    expect(command.classSpread(ROSTER.members)).toEqual([
      ['Warrior', 2],
      ['Paladin', 1],
      ['Mage', 1]
    ]);
  });

  it('ignores members with missing data', () => {
    expect(command.levelSpread([{ character: {} }])).toEqual([]);
    expect(command.classSpread([{ character: {} }])).toEqual([]);
  });
});

describe('/guild', () => {
  it('summarises the roster', async () => {
    const target = interaction({ guild: 'Stoneformed', realm: 'Nightslayer' });

    await command.execute(target);

    const embed = embedOf(target);
    expect(embed.title).toContain('Stoneformed');
    expect(field(embed, 'Members').value).toBe('4');
    expect(field(embed, 'At Level 70').value).toBe('3');
    expect(field(embed, 'Faction').value).toBe('Alliance');
  });

  it('identifies the guild master as rank 0', async () => {
    const target = interaction({ guild: 'Stoneformed', realm: 'Nightslayer' });

    await command.execute(target);

    expect(field(embedOf(target), 'Guild Master').value).toBe('Zuggbeard');
  });

  it('lists the max-level members, who are the raid-relevant ones', async () => {
    const target = interaction({ guild: 'Stoneformed', realm: 'Nightslayer' });

    await command.execute(target);

    const listed = field(embedOf(target), 'Level 70 Members').value;
    expect(listed).toContain('Zuggbeard');
    expect(listed).not.toContain('Lowbie');
  });

  it('derives max level from the roster rather than assuming 70', async () => {
    getGuildRoster.mockResolvedValue({
      guild: { name: 'Levellers' },
      members: [member('A', 60, 0), member('B', 45, 1)]
    });
    const target = interaction({ guild: 'Levellers', realm: 'Nightslayer' });

    await command.execute(target);

    expect(field(embedOf(target), 'At Level 60').value).toBe('1');
  });

  it('explains a guild that does not exist, and names the slug tried', async () => {
    getGuildRoster.mockRejectedValue(new BlizzardApiError('Not found.', { status: 404 }));
    const target = interaction({ guild: 'Definitely Not A Guild', realm: 'Nightslayer' });

    await command.execute(target);

    const text = payload(target);
    expect(text).toContain('No guild called');
    expect(text).toContain('definitely-not-a-guild');
    // There is no guild index, so no "did you mean" is possible.
    expect(text).toContain('no guild index');
  });

  it('rethrows failures that are not a missing guild', async () => {
    getGuildRoster.mockRejectedValue(new BlizzardApiError('boom', { status: 500 }));

    await expect(
      command.execute(interaction({ guild: 'Stoneformed', realm: 'Nightslayer' }))
    ).rejects.toThrow('boom');
  });

  it('handles an empty roster', async () => {
    getGuildRoster.mockResolvedValue({ guild: { name: 'Ghosts' }, members: [] });
    const target = interaction({ guild: 'Ghosts', realm: 'Nightslayer' });

    await command.execute(target);

    expect(payload(target)).toContain('no members');
  });

  it('requires a realm when none is configured', async () => {
    const saved = process.env.BLIZZARD_REALM;
    delete process.env.BLIZZARD_REALM;

    try {
      const target = interaction({ guild: 'Stoneformed' });
      await command.execute(target);

      expect(payload(target)).toContain('No realm given');
    } finally {
      process.env.BLIZZARD_REALM = saved;
    }
  });
});
