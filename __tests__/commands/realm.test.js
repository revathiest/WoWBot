jest.mock('../../utils/blizzard/gameData', () => ({
  getRulesetAuctionIndex: jest.fn()
}));

jest.mock('../../utils/blizzard/rulesets', () => ({
  getRulesets: jest.fn(),
  findRuleset: jest.requireActual('../../utils/blizzard/rulesets').findRuleset
}));

const { getRulesetAuctionIndex } = require('../../utils/blizzard/gameData');
const { getRulesets } = require('../../utils/blizzard/rulesets');
const command = require('../../commands/wow/realm');
const { createInteraction, field, replyEmbed } = require('../helpers/interaction');

const RULESETS = [
  { id: 2, name: 'Normal', slug: 'normal', status: 'UP', statusLabel: 'Up', auctionsHref: 'a/2' },
  { id: 1, name: 'PvP', slug: 'pvp', status: 'UP', statusLabel: 'Up', auctionsHref: 'a/1' },
  {
    id: 15,
    name: 'Roleplay PvP',
    slug: 'roleplay-pvp',
    status: 'DOWN',
    statusLabel: 'Down',
    auctionsHref: 'a/15'
  }
];

function interaction(overrides = {}) {
  return createInteraction({ commandName: 'realm', options: { ...overrides } });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  getRulesets.mockResolvedValue(RULESETS);
  getRulesetAuctionIndex.mockResolvedValue({ auctions: new Array(15).fill({}) });
});

afterEach(() => jest.restoreAllMocks());

describe('/realm definition', () => {
  it('takes an optional ruleset and region', () => {
    const json = command.data.toJSON();

    expect(json.options.map(option => [option.name, option.required])).toEqual([
      ['ruleset', false],
      ['region', false]
    ]);
  });
});

describe('/realm', () => {
  it('shows one ruleset with its status, id, and auction houses', async () => {
    const target = interaction({ ruleset: 'Normal' });
    await command.execute(target);

    const embed = replyEmbed(target);
    expect(embed.title).toBe('Normal (US)');
    expect(field(embed, 'Status').value).toBe('Up');
    expect(field(embed, 'Ruleset ID').value).toBe('2');
    expect(field(embed, 'Auction Houses').value).toBe('15');
    expect(embed.color).toBe(0x43b581);
  });

  it('turns the embed red when a ruleset is down', async () => {
    const target = interaction({ ruleset: 'Roleplay PvP' });
    await command.execute(target);

    const embed = replyEmbed(target);
    expect(field(embed, 'Status').value).toBe('Down');
    expect(embed.color).toBe(0xf04747);
  });

  it('lists every ruleset when none is named', async () => {
    const target = interaction();
    await command.execute(target);

    const embed = replyEmbed(target);
    expect(embed.title).toBe('Rulesets — US');
    expect(embed.description).toContain('Normal');
    expect(embed.description).toContain('Roleplay PvP');
  });

  it('matches a ruleset by id as well as by name', async () => {
    const target = interaction({ ruleset: '15' });
    await command.execute(target);

    expect(replyEmbed(target).title).toBe('Roleplay PvP (US)');
  });

  it('names the available rulesets when the one asked for does not exist', async () => {
    const target = interaction({ ruleset: 'Nonsense' });
    await command.execute(target);

    const reply = target.editReply.mock.calls[0][0];
    expect(reply).toContain('Nonsense');
    expect(reply).toContain('Normal');
  });

  it('still reports status when the auction lookup fails', async () => {
    getRulesetAuctionIndex.mockRejectedValue(new Error('offline'));

    const target = interaction({ ruleset: 'Normal' });
    await command.execute(target);

    const embed = replyEmbed(target);
    expect(field(embed, 'Status').value).toBe('Up');
    expect(embed.fields.some(entry => entry.name === 'Auction Houses')).toBe(false);
  });

  it('reports an unreadable ruleset list rather than throwing', async () => {
    getRulesets.mockRejectedValue(new Error('offline'));

    const target = interaction({ ruleset: 'Normal' });
    await command.execute(target);

    expect(target.editReply.mock.calls[0][0]).toContain('Could not read the ruleset list');
  });

  it('reports an empty ruleset list', async () => {
    getRulesets.mockResolvedValue([]);

    const target = interaction();
    await command.execute(target);

    expect(target.editReply.mock.calls[0][0]).toContain('No rulesets found');
  });

  it('passes the chosen region through', async () => {
    const target = interaction({ ruleset: 'Normal', region: 'eu' });
    await command.execute(target);

    expect(getRulesets).toHaveBeenCalledWith({ region: 'eu' });
    expect(replyEmbed(target).title).toBe('Normal (EU)');
  });
});
