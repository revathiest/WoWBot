jest.mock('../../../utils/reports/history');
jest.mock('../../../utils/reports/links', () => ({
  ...jest.requireActual('../../../utils/reports/links'),
  buildOwnerIndex: jest.fn()
}));

const { loadSnapshot } = require('../../../utils/reports/history');
const { buildOwnerIndex, characterKey } = require('../../../utils/reports/links');
const { ROSTER_BUTTON_PREFIX } = require('../../../utils/reports/render');
const {
  MAX_FIELDS_PER_GROUP,
  buildBreakdownEmbed,
  handleComponent,
  nameFields
} = require('../../../utils/reports/component');

const KEY = 'us:anniversary:nightslayer:apex';

function snapshot(names = ['Butud', 'Stranger']) {
  return {
    guild: { name: 'Apex', realm: 'Nightslayer', realmSlug: 'nightslayer' },
    capturedAt: 1000,
    members: Object.fromEntries(
      names.map(name => [name.toLowerCase(), { name, level: 70, className: 'Rogue' }])
    )
  };
}

function interaction({ customId = `${ROSTER_BUTTON_PREFIX}${KEY}`, dmFails = false, guild } = {}) {
  return {
    customId,
    isButton: () => true,
    isModalSubmit: () => false,
    guild:
      guild ??
      {
        id: 'g1',
        members: {
          fetch: jest.fn(async () =>
            new Map([
              ['u1', { id: 'u1', displayName: 'Ken', user: {} }],
              ['u9', { id: 'u9', displayName: 'NewFriend', user: {} }]
            ])
          )
        }
      },
    user: {
      id: 'presser',
      send: jest.fn(async () => {
        if (dmFails) throw new Error('Cannot send messages to this user');
      })
    },
    reply: jest.fn(async () => {}),
    deferReply: jest.fn(async () => {}),
    editReply: jest.fn(async () => {})
  };
}

function said(fake) {
  const call = fake.editReply.mock.calls.at(-1) ?? fake.reply.mock.calls.at(-1);
  const payload = call[0];
  return typeof payload === 'string' ? payload : payload.content;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  loadSnapshot.mockReturnValue(snapshot());
  buildOwnerIndex.mockReturnValue(
    new Map([[characterKey({ name: 'Butud', realm: 'nightslayer' }), 'u1']])
  );
});

afterEach(() => jest.restoreAllMocks());

describe('nameFields', () => {
  it('is empty for an empty group, so the embed skips it', () => {
    expect(nameFields('On Discord', [])).toEqual([]);
  });

  it('counts the group in the field name', () => {
    const [field] = nameFields('On Discord', [{ name: 'A' }, { name: 'B' }], { emoji: '🟢' });
    expect(field.name).toBe('🟢 On Discord (2)');
  });

  it('splits a long list across fields rather than exceeding the limit', () => {
    const members = Array.from({ length: 300 }, (_, i) => ({ name: `Character${i}` }));
    const fields = nameFields('Not linked', members);

    fields.forEach(field => expect(field.value.length).toBeLessThanOrEqual(1024));
    expect(fields.length).toBeGreaterThan(1);
  });

  it('caps the number of fields and says how many were dropped', () => {
    const members = Array.from({ length: 2000 }, (_, i) => ({ name: `Character${i}` }));
    const fields = nameFields('Not linked', members);

    expect(fields.length).toBeLessThanOrEqual(MAX_FIELDS_PER_GROUP);
    expect(fields.at(-1).value).toContain('more');
  });
});

describe('buildBreakdownEmbed', () => {
  const split = {
    onDiscord: [{ name: 'Butud' }],
    left: [{ name: 'Departed' }],
    unlinked: [{ name: 'Stranger' }]
  };

  it('leads with a headcount, not a character count', () => {
    // Two characters owned by one account are one person.
    const alts = {
      onDiscord: [{ name: 'Butud', userId: 'u1' }, { name: 'Alt', userId: 'u1' }],
      left: [],
      unlinked: []
    };

    const embed = buildBreakdownEmbed({ guild: { name: 'Apex' }, split: alts }).toJSON();

    expect(embed.description).toContain('1 person is');
    expect(embed.description).toContain('from 2 characters');
  });

  it('counts unclaimed characters apart, since nobody knows whose they are', () => {
    const embed = buildBreakdownEmbed({ guild: { name: 'Apex' }, split }).toJSON();
    expect(embed.description).toContain('claimed by nobody');
  });

  it('lists people who are in the server but not on the roster', () => {
    const embed = buildBreakdownEmbed({
      guild: { name: 'Apex' },
      split,
      outsiders: [{ id: 'u9', name: 'NewFriend' }]
    }).toJSON();

    expect(embed.fields.find(f => f.name.includes('not in the guild')).value).toContain('NewFriend');
  });

  it('omits that section when everybody in the server is on the roster', () => {
    const embed = buildBreakdownEmbed({ guild: { name: 'Apex' }, split, outsiders: [] }).toJSON();
    expect(embed.fields.some(f => f.name.includes('not in the guild'))).toBe(false);
  });

  it('keeps the three groups apart', () => {
    const embed = buildBreakdownEmbed({ guild: { name: 'Apex' }, split }).toJSON();
    const names = embed.fields.map(f => f.name);

    expect(names.some(n => n.includes('On Discord'))).toBe(true);
    expect(names.some(n => n.includes('left the server'))).toBe(true);
    expect(names.some(n => n.includes('Not linked'))).toBe(true);
  });

  it('explains what "not linked" actually means', () => {
    // It is not proof of absence, and the DM must not imply it is.
    const embed = buildBreakdownEmbed({ guild: { name: 'Apex' }, split }).toJSON();
    expect(embed.fields.find(f => f.name === 'About "not linked"').value).toContain('/iam add');
  });

  it('omits that caveat when everyone is linked', () => {
    const embed = buildBreakdownEmbed({
      guild: { name: 'Apex' },
      split: { onDiscord: [{ name: 'Butud' }], left: [], unlinked: [] }
    }).toJSON();

    expect(embed.fields.some(f => f.name === 'About "not linked"')).toBe(false);
  });
});

describe('handleComponent', () => {
  it('ignores components it does not own', async () => {
    expect(await handleComponent(interaction({ customId: 'ticket:create' }))).toBe(false);
  });

  it('DMs the breakdown to whoever pressed the button', async () => {
    const fake = interaction();

    expect(await handleComponent(fake)).toBe(true);
    expect(fake.user.send).toHaveBeenCalled();
    expect(said(fake)).toContain('DM');
  });

  it('falls back to an ephemeral reply when DMs are closed', async () => {
    const fake = interaction({ dmFails: true });
    await handleComponent(fake);

    expect(fake.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) })
    );
  });

  it('splits the roster using the links and the server member list', async () => {
    const fake = interaction();
    await handleComponent(fake);

    const embed = fake.user.send.mock.calls[0][0].embeds[0].toJSON();

    expect(embed.description).toContain('1 person is');
  });

  it('names server members who hold no roster character', async () => {
    const fake = interaction();
    await handleComponent(fake);

    const embed = fake.user.send.mock.calls[0][0].embeds[0].toJSON();

    expect(embed.fields.find(f => f.name.includes('not in the guild')).value).toContain('NewFriend');
  });

  it('says so when there is no stored roster yet', async () => {
    loadSnapshot.mockReturnValue(null);
    const fake = interaction();

    expect(await handleComponent(fake)).toBe(true);
    expect(said(fake)).toContain('no stored roster');
    expect(fake.user.send).not.toHaveBeenCalled();
  });

  it('still works when the member list cannot be read', async () => {
    const guild = { id: 'g1', members: { fetch: jest.fn(async () => { throw new Error('nope'); }) } };
    const fake = interaction({ guild });

    expect(await handleComponent(fake)).toBe(true);
    expect(fake.user.send).toHaveBeenCalled();
  });
});
