jest.mock('../../utils/blizzard/guild', () => {
  const actual = jest.requireActual('../../utils/blizzard/guild');
  return { ...actual, getGuildRoster: jest.fn() };
});

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

const member = (name, surname, level, rank, className = 'Paladin') => ({
  rank,
  character: { name, surname, level, playable_class: { name: className } }
});

const ROSTER = {
  guild: { name: 'Circle of Lore', faction: { name: 'Alliance' } },
  members: [
    member('Judgement', 'Judy', 10, 0, 'Paladin'),
    member('Zin', 'Karhel', 10, 1, 'Warlock'),
    member('Doc', 'Trevena', 10, 2, 'Paladin'),
    member('Penny', 'Aldor', 6, 5, 'Mage')
  ]
};

beforeEach(() => {
  jest.clearAllMocks();
  getGuildRoster.mockResolvedValue(ROSTER);
});

describe('slugifyGuild', () => {
  it('follows the same rule realm names used to', () => {
    expect(slugifyGuild('Circle of Lore')).toBe('circle-of-lore');
    expect(slugifyGuild('Knights of the Round')).toBe('knights-of-the-round');
    // Punctuation is deleted, not turned into a separator.
    expect(slugifyGuild("Knight's Watch")).toBe('knights-watch');
  });
});

describe('levelSpread and classSpread', () => {
  it('counts members per level, highest first', () => {
    expect(command.levelSpread(ROSTER.members)).toEqual([
      [10, 3],
      [6, 1]
    ]);
  });

  it('counts members per class, largest first', () => {
    expect(command.classSpread(ROSTER.members)).toEqual([
      ['Paladin', 2],
      ['Warlock', 1],
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
    const target = interaction({ guild: 'Circle of Lore' });

    await command.execute(target);

    const embed = embedOf(target);
    expect(embed.title).toBe('Circle of Lore — US');
    expect(field(embed, 'Members').value).toBe('4');
    expect(field(embed, 'At Level 10').value).toBe('3');
    expect(field(embed, 'Faction').value).toBe('Alliance');
  });

  it('identifies the guild master as rank 0', async () => {
    const target = interaction({ guild: 'Circle of Lore' });

    await command.execute(target);

    expect(field(embedOf(target), 'Guild Master').value).toBe('Judgement');
  });

  it('lists the max-level members, who are the raid-relevant ones', async () => {
    const target = interaction({ guild: 'Circle of Lore' });

    await command.execute(target);

    const listed = field(embedOf(target), 'Level 10 Members').value;
    expect(listed).toContain('Judgement');
    expect(listed).not.toContain('Penny');
  });

  it('derives max level from the roster rather than assuming one', async () => {
    getGuildRoster.mockResolvedValue({
      guild: { name: 'Levellers' },
      members: [member('A', 'X', 8, 0), member('B', 'Y', 5, 1)]
    });
    const target = interaction({ guild: 'Levellers' });

    await command.execute(target);

    expect(field(embedOf(target), 'At Level 8').value).toBe('1');
  });

  it('passes the chosen region through to the API', async () => {
    const target = interaction({ guild: 'Circle of Lore', region: 'eu' });

    await command.execute(target);

    expect(getGuildRoster).toHaveBeenCalledWith('circle-of-lore', { region: 'eu' });
  });

  it('explains a guild that does not exist, and names the slug tried', async () => {
    getGuildRoster.mockRejectedValue(new BlizzardApiError('Not found.', { status: 404 }));
    const target = interaction({ guild: 'Definitely Not A Guild' });

    await command.execute(target);

    const text = payload(target);
    expect(text).toContain('No guild called');
    expect(text).toContain('definitely-not-a-guild');
    // There is no guild index, so no "did you mean" is possible.
    expect(text).toContain('no guild index');
  });

  it('rethrows failures that are not a missing guild', async () => {
    getGuildRoster.mockRejectedValue(new BlizzardApiError('boom', { status: 500 }));

    await expect(command.execute(interaction({ guild: 'Circle of Lore' }))).rejects.toThrow('boom');
  });

  it('handles an empty roster', async () => {
    getGuildRoster.mockResolvedValue({ guild: { name: 'Ghosts' }, members: [] });
    const target = interaction({ guild: 'Ghosts' });

    await command.execute(target);

    expect(payload(target)).toContain('no members');
  });
});
