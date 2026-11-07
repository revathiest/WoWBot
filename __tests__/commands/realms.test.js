jest.mock('../../utils/blizzard/rulesets', () => ({
  getRulesets: jest.fn(),
  searchRulesets: jest.requireActual('../../utils/blizzard/rulesets').searchRulesets
}));

const { getRulesets } = require('../../utils/blizzard/rulesets');
const command = require('../../commands/wow/realms');
const { createInteraction, replyEmbed, replyPayload } = require('../helpers/interaction');

const ruleset = (id, name, slug, status = 'UP') => ({ id, name, slug, status, statusLabel: status === 'UP' ? 'Up' : 'Down' });

const RULESETS = [
  ruleset(2, 'Normal', 'normal'),
  ruleset(1, 'PvP', 'pvp'),
  ruleset(3, 'Roleplay', 'roleplay'),
  ruleset(15, 'Roleplay PvP', 'roleplay-pvp', 'DOWN')
];

function interaction(options = {}) {
  return createInteraction({ commandName: 'realms', options });
}

beforeEach(() => {
  jest.clearAllMocks();
  getRulesets.mockResolvedValue(RULESETS);
});

describe('/realms definition', () => {
  it('takes optional search and region', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('realms');
    expect(json.options.map(option => [option.name, option.required])).toEqual([
      ['search', false],
      ['region', false]
    ]);
  });
});

describe('/realms execute', () => {
  it('lists every ruleset when no search is given', async () => {
    const target = interaction();

    await command.execute(target);

    expect(getRulesets).toHaveBeenCalledWith({ region: 'us' });

    const embed = replyEmbed(target);
    expect(embed.title).toBe('Rulesets — US');
    expect(embed.description).toContain('4 ruleset(s)');
    expect(embed.fields.map(f => f.name)).toEqual(['Normal', 'PvP', 'Roleplay', 'Roleplay PvP']);
    expect(embed.fields.find(f => f.name === 'Roleplay PvP').value).toContain('🔴');
  });

  it('passes the chosen region through', async () => {
    const target = interaction({ region: 'eu' });

    await command.execute(target);

    expect(getRulesets).toHaveBeenCalledWith({ region: 'eu' });
    expect(replyEmbed(target).title).toBe('Rulesets — EU');
  });

  it('shows slugs when searching, so the exact value is visible', async () => {
    const target = interaction({ search: 'roleplay' });

    await command.execute(target);

    const embed = replyEmbed(target);
    expect(embed.title).toContain('matching "roleplay"');
    expect(embed.description).toContain('**Roleplay**');
    expect(embed.description).toContain('`roleplay`');
    expect(embed.description).toContain('**Roleplay PvP**');
  });

  it('matches loosely, ignoring punctuation and case', async () => {
    const target = interaction({ search: 'PVP' });

    await command.execute(target);

    const description = replyEmbed(target).description;
    expect(description).toContain('PvP');
    expect(description).toContain('Roleplay PvP');
  });

  it('reports a search that matches nothing', async () => {
    const target = interaction({ search: 'nonsense' });

    await command.execute(target);

    expect(replyPayload(target)).toContain('No ruleset in US matches');
  });

  it('reports an empty ruleset list', async () => {
    getRulesets.mockResolvedValue([]);
    const target = interaction();

    await command.execute(target);

    expect(replyPayload(target)).toContain('No rulesets found');
  });

  it('footnotes a long list of search matches', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ruleset(i, `Testruleset ${i}`, `testruleset-${i}`));
    getRulesets.mockResolvedValue(many);
    const target = interaction({ search: 'testruleset' });

    await command.execute(target);

    expect(replyEmbed(target).footer.text).toContain('Showing 40 of 50');
  });
});
