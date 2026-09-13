jest.mock('../../utils/blizzard/realms', () => ({
  getPlayableRealms: jest.fn(),
  searchRealms: jest.requireActual('../../utils/blizzard/realms').searchRealms
}));

const { getPlayableRealms } = require('../../utils/blizzard/realms');
const command = require('../../commands/wow/realms');
const { createInteraction, replyEmbed, replyPayload } = require('../helpers/interaction');

const realm = (name, slug) => ({ name, slug, internal: false });

const REALMS = [
  realm('Aegwynn', 'aegwynn'),
  realm('Area 52', 'area-52'),
  realm('Argent Dawn', 'argent-dawn'),
  realm('Azjol-Nerub', 'azjolnerub'),
  realm('Maladath', 'maladath')
];

function interaction(options = {}) {
  return createInteraction({ commandName: 'realms', options });
}

beforeEach(() => {
  jest.clearAllMocks();
  getPlayableRealms.mockResolvedValue(REALMS);
});

describe('/realms definition', () => {
  it('takes optional search, game, and region', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('realms');
    expect(json.options.map(option => [option.name, option.required])).toEqual([
      ['search', false],
      ['game', false],
      ['region', false]
    ]);
  });
});

describe('groupIntoFields', () => {
  it('labels a group with its alphabetical range', () => {
    const [group] = command.groupIntoFields(['Aegwynn', 'Area 52', 'Azjol-Nerub']);

    expect(group.name).toBe('Aegwynn – Azjol-Nerub');
    expect(group.value).toBe('Aegwynn, Area 52, Azjol-Nerub');
  });

  it('splits once a field would exceed the character limit', () => {
    const names = Array.from({ length: 20 }, (_, i) => `Realm Number ${i}`);
    const groups = command.groupIntoFields(names, { maxChars: 60 });

    expect(groups.length).toBeGreaterThan(1);
    groups.forEach(group => expect(group.value.length).toBeLessThanOrEqual(60));
  });

  it('names a single-entry group after that entry', () => {
    expect(command.groupIntoFields(['Solo'])[0].name).toBe('Solo');
  });

  it('never exceeds the field cap', () => {
    const names = Array.from({ length: 500 }, (_, i) => `Realm ${i}`);
    expect(command.groupIntoFields(names, { maxChars: 30, maxTotal: 100000 })).toHaveLength(25);
  });

  it('stops before breaching the overall embed size limit', () => {
    const names = Array.from({ length: 500 }, (_, i) => `Realm Number ${i}`);
    const groups = command.groupIntoFields(names, { maxTotal: 200 });

    const total = groups.reduce((sum, g) => sum + g.value.length, 0);
    expect(total).toBeLessThanOrEqual(200);
  });
});

describe('/realms execute', () => {
  it('lists every playable realm when no search is given', async () => {
    const target = interaction();

    await command.execute(target);

    expect(getPlayableRealms).toHaveBeenCalledWith({ region: 'us', game: 'retail' });

    const embed = replyEmbed(target);
    expect(embed.title).toBe('Realms — US');
    expect(embed.description).toContain('5 playable realm(s)');
    expect(embed.fields[0].value).toContain('Maladath');
  });

  it('labels the scope with the game version when it is not retail', async () => {
    const target = interaction({ game: 'classic', region: 'eu' });

    await command.execute(target);

    expect(getPlayableRealms).toHaveBeenCalledWith({ region: 'eu', game: 'classic' });
    expect(replyEmbed(target).title).toBe('Realms — EU · Classic');
  });

  it('shows slugs when searching, so the exact value is visible', async () => {
    const target = interaction({ search: 'azjol' });

    await command.execute(target);

    const embed = replyEmbed(target);
    expect(embed.title).toContain('matching "azjol"');
    expect(embed.description).toContain('**Azjol-Nerub**');
    expect(embed.description).toContain('`azjolnerub`');
  });

  it('matches loosely, ignoring punctuation', async () => {
    const target = interaction({ search: 'area-52' });

    await command.execute(target);

    expect(replyEmbed(target).description).toContain('Area 52');
  });

  it('reports a search that matches nothing', async () => {
    const target = interaction({ search: 'nonsense' });

    await command.execute(target);

    expect(replyPayload(target)).toContain('No realm in US matches');
  });

  it('reports an empty realm list', async () => {
    getPlayableRealms.mockResolvedValue([]);
    const target = interaction();

    await command.execute(target);

    expect(replyPayload(target)).toContain('No realms found');
  });

  it('footnotes the count when the list is truncated', async () => {
    const many = Array.from({ length: 400 }, (_, i) => realm(`Realm Number ${String(i).padStart(3, '0')}`, `realm-${i}`));
    getPlayableRealms.mockResolvedValue(many);
    const target = interaction();

    await command.execute(target);

    const embed = replyEmbed(target);
    expect(embed.fields.length).toBeLessThanOrEqual(25);
    expect(embed.footer.text).toContain('of 400');
  });

  it('footnotes a long list of search matches', async () => {
    const many = Array.from({ length: 60 }, (_, i) => realm(`Testrealm ${i}`, `testrealm-${i}`));
    getPlayableRealms.mockResolvedValue(many);
    const target = interaction({ search: 'testrealm' });

    await command.execute(target);

    expect(replyEmbed(target).footer.text).toContain('Showing 40 of 60');
  });
});
