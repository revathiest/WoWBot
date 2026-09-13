jest.mock('../../utils/blizzard/pvp', () => {
  const actual = jest.requireActual('../../utils/blizzard/pvp');
  return {
    ...actual,
    getCurrentSeasonId: jest.fn(),
    getLeaderboard: jest.fn()
  };
});

jest.mock('../../utils/blizzard/realms', () => ({
  resolveRealm: jest.fn(async query => ({
    slug: String(query).toLowerCase(),
    name: query,
    resolved: true
  }))
}));

const { getCurrentSeasonId, getLeaderboard } = require('../../utils/blizzard/pvp');
const command = require('../../commands/wow/arena');
const { field } = require('../helpers/interaction');

function interaction(options = {}, subcommand = 'ladder') {
  const reply = jest.fn(async () => {});
  return {
    options: {
      getString: name => options[name] ?? null,
      getInteger: name => options[name] ?? null,
      getBoolean: name => options[name] ?? null,
      getSubcommand: () => subcommand,
      getSubcommandGroup: () => null
    },
    deferReply: jest.fn(async () => {}),
    editReply: reply
  };
}

const payload = target => target.editReply.mock.calls[target.editReply.mock.calls.length - 1][0];
const embedOf = target => payload(target).embeds[0].toJSON();

const entry = (name, realm, rank, rating, won = 10, lost = 5) => ({
  rank,
  rating,
  character: { name, realm: { slug: realm } },
  season_match_statistics: { won, lost }
});

const LADDER = [
  entry('Mosquietos', 'nightslayer', 1, 2341, 164, 59),
  entry('Trackpad', 'nightslayer', 2, 2338, 109, 37),
  entry('Someone', 'dreamscythe', 3, 2300)
];

beforeEach(() => {
  jest.clearAllMocks();
  getCurrentSeasonId.mockResolvedValue(3);
  getLeaderboard.mockResolvedValue(LADDER);
});

describe('/arena definition', () => {
  it('offers ladder and rank', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('arena');
    expect(json.options.map(option => option.name)).toEqual(['ladder', 'rank']);
  });

  it('offers only the brackets TBC has', () => {
    const ladder = command.data.toJSON().options.find(option => option.name === 'ladder');
    const bracket = ladder.options.find(option => option.name === 'bracket');

    expect(bracket.choices.map(choice => choice.value)).toEqual(['2v2', '3v3', '5v5']);
  });
});

describe('formatEntry', () => {
  it('shows rank, name, rating and record', () => {
    const line = command.formatEntry(entry('Mosquietos', 'nightslayer', 1, 2341, 164, 59));

    expect(line).toContain('#  1');
    expect(line).toContain('**Mosquietos**-nightslayer');
    expect(line).toContain('2,341');
    expect(line).toContain('(164W/59L)');
  });

  it('can hide the realm when the ladder is already realm-filtered', () => {
    expect(command.formatEntry(entry('A', 'nightslayer', 1, 2000), { showRealm: false })).not.toContain(
      'nightslayer'
    );
  });
});

describe('/arena ladder', () => {
  it('shows the top of the requested bracket', async () => {
    const target = interaction({ bracket: '3v3', limit: 2 });

    await command.execute(target);

    const embed = embedOf(target);
    expect(embed.title).toContain('3v3 Ladder');
    expect(embed.description.split('\n')).toHaveLength(2);
    expect(embed.description).toContain('Mosquietos');
    expect(embed.footer.text).toContain('Season 3');
  });

  it('filters to one realm on request', async () => {
    const target = interaction({ bracket: '3v3', 'this-realm-only': true, realm: 'Nightslayer' });

    await command.execute(target);

    const embed = embedOf(target);
    expect(embed.description).not.toContain('Someone');
    expect(embed.footer.text).toContain('ranked on nightslayer');
  });

  it('says so when a bracket is empty', async () => {
    getLeaderboard.mockResolvedValue([]);
    const target = interaction({ bracket: '5v5' });

    await command.execute(target);

    expect(embedOf(target).description).toContain('Nobody is ranked');
  });

  it('reports when no season exists for this game version', async () => {
    getCurrentSeasonId.mockResolvedValue(null);
    const target = interaction({ bracket: '3v3' });

    await command.execute(target);

    expect(payload(target)).toContain('No PvP season');
  });
});

describe('/arena rank', () => {
  it('reports standing in every bracket the character appears in', async () => {
    const target = interaction({ character: 'Mosquietos', realm: 'Nightslayer' }, 'rank');

    await command.execute(target);

    const embed = embedOf(target);
    const bracket = field(embed, '2v2');
    expect(bracket.value).toContain('2,341');
    expect(bracket.value).toContain('#1');
    // 164 of 223 games is 74%.
    expect(bracket.value).toContain('74%');
  });

  it('explains an unranked character rather than erroring', async () => {
    const target = interaction({ character: 'Zuggbeard', realm: 'Nightslayer' }, 'rank');

    await command.execute(target);

    const embed = embedOf(target);
    expect(embed.description).toContain('not ranked in any bracket');
    // The distinction that matters: honor is not arena.
    expect(embed.description).toContain('honor from world PvP');
  });

  it('requires a realm when none is configured', async () => {
    // jest.setup.js pins BLIZZARD_REALM, so clear it to reach this branch.
    const saved = process.env.BLIZZARD_REALM;
    delete process.env.BLIZZARD_REALM;

    try {
      const target = interaction({ character: 'Zuggbeard' }, 'rank');
      await command.execute(target);

      expect(payload(target)).toContain('No realm given');
    } finally {
      process.env.BLIZZARD_REALM = saved;
    }
  });
});
