jest.mock('../../utils/blizzard/gameData', () => ({
  getWowTokenPrice: jest.fn()
}));

const { getWowTokenPrice } = require('../../utils/blizzard/gameData');
const command = require('../../commands/wow/token');
const { createInteraction, field, replyEmbed } = require('../helpers/interaction');

beforeEach(() => {
  jest.clearAllMocks();
  getWowTokenPrice.mockResolvedValue({
    price: 2000000000,
    last_updated_timestamp: 1700000000000
  });
});

describe('/token', () => {
  it('takes optional game and region', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('token');
    expect(json.options.map(option => [option.name, option.required])).toEqual([
      ['game', false],
      ['region', false]
    ]);
  });

  it('reports the price in gold with an update time', async () => {
    const interaction = createInteraction({ commandName: 'token' });

    await command.execute(interaction);

    const embed = replyEmbed(interaction);
    expect(embed.title).toBe('WoW Token — US');
    expect(field(embed, 'Price').value).toBe('200,000g');
    expect(field(embed, 'Updated').value).toBe('<t:1700000000:R>');
  });

  it('prices the token in the requested region', async () => {
    const interaction = createInteraction({ commandName: 'token', options: { region: 'kr' } });

    await command.execute(interaction);

    expect(getWowTokenPrice).toHaveBeenCalledWith({ region: 'kr', game: 'retail' });
    expect(replyEmbed(interaction).title).toBe('WoW Token — KR');
  });

  it('omits the update time when the API does not send one', () => {
    const embed = command.buildEmbed({ token: { price: 100 }, scopeLabel: 'US' }).toJSON();

    expect(field(embed, 'Updated')).toBeUndefined();
    expect(field(embed, 'Price').value).toBe('1s');
  });
});
