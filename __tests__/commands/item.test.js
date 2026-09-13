jest.mock('../../utils/blizzard/gameData', () => ({
  getItem: jest.fn(),
  getItemMedia: jest.fn(),
  searchItems: jest.fn()
}));

const { getItem, getItemMedia, searchItems } = require('../../utils/blizzard/gameData');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const command = require('../../commands/wow/item');
const { createInteraction, field, replyEmbed, replyPayload } = require('../helpers/interaction');

const ITEM = {
  id: 19019,
  name: 'Thunderfury, Blessed Blade of the Windseeker',
  quality: { type: 'LEGENDARY', name: 'Legendary' },
  level: 80,
  required_level: 60,
  item_class: { name: 'Weapon' },
  item_subclass: { name: 'Sword' },
  inventory_type: { type: 'WEAPON', name: 'One-Hand' },
  sell_price: 123456
};

function interaction(query, overrides = {}) {
  return createInteraction({ commandName: 'item', options: { query, ...overrides } });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  getItem.mockResolvedValue(ITEM);
  getItemMedia.mockResolvedValue({ assets: [{ key: 'icon', value: 'https://render/icon.jpg' }] });
});

afterEach(() => jest.restoreAllMocks());

describe('isItemId', () => {
  it('recognises numeric queries only', () => {
    expect(command.isItemId('19019')).toBe(true);
    expect(command.isItemId('  19019 ')).toBe(true);
    expect(command.isItemId('Thunderfury')).toBe(false);
    expect(command.isItemId('19019a')).toBe(false);
  });
});

describe('/item by id', () => {
  it('fetches the item directly and renders its details', async () => {
    const target = interaction('19019');

    await command.execute(target);

    expect(getItem).toHaveBeenCalledWith('19019', { region: 'us', game: 'retail' });
    expect(searchItems).not.toHaveBeenCalled();

    const embed = replyEmbed(target);
    expect(embed.title).toBe('Thunderfury, Blessed Blade of the Windseeker');
    expect(embed.url).toBe('https://www.wowhead.com/item=19019');
    expect(embed.color).toBe(0xff8000); // legendary orange
    expect(field(embed, 'Item ID').value).toBe('19019');
    expect(field(embed, 'Quality').value).toBe('Legendary');
    expect(field(embed, 'Item Level').value).toBe('80');
    expect(field(embed, 'Type').value).toBe('Weapon — Sword');
    expect(field(embed, 'Slot').value).toBe('One-Hand');
    expect(field(embed, 'Requires Level').value).toBe('60');
    expect(field(embed, 'Sells For').value).toBe('12g 34s 56c');
    expect(embed.thumbnail.url).toBe('https://render/icon.jpg');
  });

  it('reports an unknown id', async () => {
    getItem.mockRejectedValue(new BlizzardApiError('Not found.', { status: 404 }));
    const target = interaction('1');

    await command.execute(target);

    expect(replyPayload(target)).toContain('No item with ID **1**');
  });

  it('rethrows other failures', async () => {
    getItem.mockRejectedValue(new BlizzardApiError('boom', { status: 500 }));

    await expect(command.execute(interaction('19019'))).rejects.toThrow('boom');
  });

  it('renders the item even when the icon is unavailable', async () => {
    getItemMedia.mockRejectedValue(new Error('media down'));
    const target = interaction('19019');

    await command.execute(target);

    expect(replyEmbed(target).thumbnail).toBeUndefined();
  });
});

describe('/item by name', () => {
  it('shows the full card for a single exact match', async () => {
    searchItems.mockResolvedValue({ results: [{ data: { id: 19019 } }] });
    const target = interaction('Thunderfury, Blessed Blade of the Windseeker');

    await command.execute(target);

    expect(getItem).toHaveBeenCalledWith(19019, { region: 'us', game: 'retail' });
    expect(replyEmbed(target).title).toContain('Thunderfury');
  });

  it('lists the candidates when a name is ambiguous', async () => {
    searchItems.mockResolvedValue({
      results: [
        { data: { id: 1, name: { en_US: 'Hearthstone' }, level: 1 } },
        { data: { id: 2, name: { en_US: 'Hearthstone' }, level: 5 } }
      ]
    });
    const target = interaction('Hearthstone');

    await command.execute(target);

    const payload = replyPayload(target);
    expect(payload).toContain('Found 2 items');
    expect(payload).toContain('ID `1`');
    expect(payload).toContain('ID `2`');
    expect(getItem).not.toHaveBeenCalled();
  });

  it('truncates a long candidate list', async () => {
    searchItems.mockResolvedValue({
      results: Array.from({ length: 14 }, (_, index) => ({
        data: { id: index, name: { en_US: 'Cloth' }, level: 1 }
      }))
    });
    const target = interaction('Cloth');

    await command.execute(target);

    expect(replyPayload(target)).toContain('and 4 more');
  });

  it('explains that search needs a full item name', async () => {
    searchItems.mockResolvedValue({ results: [] });
    const target = interaction('thunder');

    await command.execute(target);

    const payload = replyPayload(target);
    expect(payload).toContain('No item named');
    expect(payload).toContain('full names only');
  });

  it('searches in the requested region', async () => {
    searchItems.mockResolvedValue({ results: [] });

    await command.execute(interaction('Thunderfury', { region: 'eu' }));

    expect(searchItems).toHaveBeenCalledWith(
      'Thunderfury',
      expect.objectContaining({ region: 'eu', game: 'retail' })
    );
  });
});

describe('item embed edge cases', () => {
  it('omits optional fields that the API did not provide', () => {
    const embed = command
      .buildEmbed({
        item: { id: 5, name: { en_US: 'Linen Cloth' }, inventory_type: { name: 'Non-equippable' } },
        iconUrl: null,
        locale: 'en_US'
      })
      .toJSON();

    expect(embed.title).toBe('Linen Cloth');
    expect(field(embed, 'Quality').value).toBe('—');
    expect(field(embed, 'Item Level').value).toBe('—');
    expect(field(embed, 'Slot')).toBeUndefined();
    expect(field(embed, 'Requires Level')).toBeUndefined();
    expect(field(embed, 'Sells For')).toBeUndefined();
  });

  it('falls back when the item has no name', () => {
    expect(command.buildEmbed({ item: { id: 1 }, locale: 'en_US' }).toJSON().title).toBe(
      'Unknown item'
    );
  });
});
