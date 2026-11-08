jest.mock('../../../utils/reports/history');
jest.mock('../../../utils/reports/killHistory');
jest.mock('../../../utils/reports/links', () => ({
  ...jest.requireActual('../../../utils/reports/links'),
  buildOwnerIndex: jest.fn(),
  mainFor: jest.fn()
}));
jest.mock('../../../utils/reports/config', () => ({
  ...jest.requireActual('../../../utils/reports/config'),
  loadConfig: jest.fn()
}));

const { loadSnapshot } = require('../../../utils/reports/history');
const { loadKillHistory } = require('../../../utils/reports/killHistory');
const { buildOwnerIndex, characterKey, mainFor } = require('../../../utils/reports/links');
const { loadConfig, DEFAULTS } = require('../../../utils/reports/config');
const { KILL_TALLY_BUTTON_PREFIX, ROSTER_BUTTON_PREFIX } = require('../../../utils/reports/render');
const { embedLength } = require('../../../utils/embeds');
const {
  COLUMN_LINES,
  buildBreakdownMessages,
  buildKillTallyMessages,
  buildSummary,
  groupByOwner,
  handleComponent,
  killTallyLine,
  personLines,
  unclaimedLines
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
      guild ?? {
        id: 'g1',
        members: {
          fetch: jest.fn(
            async () =>
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
    editReply: jest.fn(async () => {}),
    followUp: jest.fn(async () => {})
  };
}

function said(fake) {
  const call = fake.editReply.mock.calls.at(-1) ?? fake.reply.mock.calls.at(-1);
  const payload = call[0];
  return typeof payload === 'string' ? payload : payload.content;
}

/** Every field across every message, flattened. */
function allFields(messages) {
  return messages.flatMap(embeds => embeds.flatMap(embed => embed.toJSON().fields ?? []));
}

/** Every rendered line across every message. */
function allLines(messages) {
  return allFields(messages).flatMap(field => field.value.split('\n'));
}

const SPLIT = {
  onDiscord: [{ name: 'Butud', userId: 'u1', level: 70 }],
  left: [{ name: 'Departed', userId: 'u2', level: 70 }],
  unlinked: [{ name: 'Stranger', level: 70, className: 'Rogue' }]
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  loadSnapshot.mockReturnValue(snapshot());
  loadKillHistory.mockReturnValue([]);
  buildOwnerIndex.mockReturnValue(
    new Map([[characterKey({ name: 'Butud', realm: 'nightslayer' }), 'u1']])
  );
  mainFor.mockReturnValue(null);
  loadConfig.mockReturnValue({ ...DEFAULTS, frequency: 'daily' });
});

afterEach(() => jest.restoreAllMocks());

describe('groupByOwner', () => {
  it('collects one account\'s characters together', () => {
    const grouped = groupByOwner(
      [
        { name: 'Alt', userId: 'u1' },
        { name: 'Butud', userId: 'u1' },
        { name: 'Other', userId: 'u2' }
      ],
      { resolveMain: () => null }
    );

    expect(grouped).toHaveLength(2);
    expect(grouped[0].characters).toHaveLength(2);
  });

  it('puts the main first, wherever it appeared', () => {
    const grouped = groupByOwner(
      [
        { name: 'Alt', userId: 'u1', level: 70 },
        { name: 'Butud', userId: 'u1', level: 70 }
      ],
      { resolveMain: () => ({ name: 'Butud' }) }
    );

    expect(grouped[0].characters[0].name).toBe('Butud');
  });

  it('falls back to level order when no main is known', () => {
    const grouped = groupByOwner(
      [
        { name: 'Low', userId: 'u1', level: 1 },
        { name: 'High', userId: 'u1', level: 70 }
      ],
      { resolveMain: () => null }
    );

    expect(grouped[0].characters.map(c => c.name)).toEqual(['High', 'Low']);
  });
});

describe('personLines', () => {
  it('shows which Discord account plays which characters', () => {
    // The whole point of the section: a name alone says nothing about whose it is.
    const [line] = personLines(
      [
        { name: 'Butud', userId: 'u1', level: 70 },
        { name: 'Alt', userId: 'u1', level: 70 }
      ],
      { resolveMain: () => ({ name: 'Butud' }) }
    );

    expect(line).toBe('<@u1> — **Butud** · Alt');
  });

  it('omits the separator for somebody with one character', () => {
    const [line] = personLines([{ name: 'Solo', userId: 'u1' }], { resolveMain: () => null });
    expect(line).toBe('<@u1> — **Solo**');
  });

  it('leads with whoever has the most characters', () => {
    const lines = personLines(
      [
        { name: 'Solo', userId: 'u2' },
        { name: 'A', userId: 'u1' },
        { name: 'B', userId: 'u1' }
      ],
      { resolveMain: () => null }
    );

    expect(lines[0]).toContain('<@u1>');
  });
});

describe('unclaimedLines', () => {
  it('puts the highest level first, since those are worth chasing', () => {
    const lines = unclaimedLines([
      { name: 'Banker', level: 1 },
      { name: 'Raider', level: 70 }
    ]);

    expect(lines[0]).toContain('Raider');
  });

  it('shows the level and class', () => {
    expect(unclaimedLines([{ name: 'Raider', level: 70, className: 'Rogue' }])[0]).toBe(
      '`70` **Raider** · Rogue'
    );
  });

  it('copes with a character whose level or class is unknown', () => {
    expect(unclaimedLines([{ name: 'Mystery' }])[0]).toBe('**Mystery**');
  });
});

describe('buildSummary', () => {
  it('counts people, not characters', () => {
    const alts = {
      onDiscord: [
        { name: 'Butud', userId: 'u1' },
        { name: 'Alt', userId: 'u1' }
      ],
      left: [],
      unlinked: []
    };

    const summary = buildSummary({ name: 'Apex' }, alts);

    expect(summary).toContain('1 person');
    expect(summary).toContain('playing 2 characters');
  });

  it('mentions departed accounts only when there are some', () => {
    expect(buildSummary({ name: 'Apex' }, SPLIT)).toContain('no longer in the server');
    expect(buildSummary({ name: 'Apex' }, { onDiscord: [], left: [], unlinked: [] })).not.toContain(
      'no longer'
    );
  });
});

describe('buildBreakdownMessages', () => {
  it('names the account beside its characters', () => {
    const alts = {
      onDiscord: [
        { name: 'Butud', userId: 'u1' },
        { name: 'Alt', userId: 'u1' }
      ],
      left: [],
      unlinked: []
    };

    const messages = buildBreakdownMessages({
      guild: { name: 'Apex' },
      split: alts,
      resolveMain: () => ({ name: 'Butud' })
    });

    expect(allFields(messages)[0].value).toBe('<@u1> — **Butud** · Alt');
  });

  it('keeps the groups apart', () => {
    const names = allFields(buildBreakdownMessages({ guild: { name: 'Apex' }, split: SPLIT })).map(
      field => field.name
    );

    expect(names.some(n => n.includes('On Discord'))).toBe(true);
    expect(names.some(n => n.includes('left the server'))).toBe(true);
    expect(names.some(n => n.includes('Claimed by nobody'))).toBe(true);
  });

  it('lists people who are in the server but not on the roster', () => {
    const messages = buildBreakdownMessages({
      guild: { name: 'Apex' },
      split: SPLIT,
      outsiders: [{ id: 'u9' }]
    });

    // A mention rather than a stored name: clickable, and always current.
    expect(allLines(messages)).toContain('<@u9>');
  });

  it('omits that section when everybody in the server is on the roster', () => {
    const messages = buildBreakdownMessages({ guild: { name: 'Apex' }, split: SPLIT });
    const names = allFields(messages).map(field => field.name);

    expect(names.some(n => n.includes('no character here'))).toBe(false);
  });

  it('explains what "claimed by nobody" actually means', () => {
    const messages = buildBreakdownMessages({ guild: { name: 'Apex' }, split: SPLIT });
    const caveat = allFields(messages).find(field => field.name.startsWith('Why'));

    expect(caveat.value).toContain('/iam add');
  });

  it('omits that caveat when everyone is linked', () => {
    const messages = buildBreakdownMessages({
      guild: { name: 'Apex' },
      split: { onDiscord: [{ name: 'Butud', userId: 'u1' }], left: [], unlinked: [] }
    });

    expect(allFields(messages).some(field => field.name.startsWith('Why'))).toBe(false);
  });

  it('lays long name lists out as columns', () => {
    const unlinked = Array.from({ length: 40 }, (_, i) => ({ name: `Char${i}`, level: 70 }));
    const messages = buildBreakdownMessages({
      guild: { name: 'Apex' },
      split: { onDiscord: [], left: [], unlinked }
    });

    const columns = allFields(messages).filter(field => field.inline);

    expect(columns.length).toBeGreaterThan(1);
    columns.forEach(field =>
      expect(field.value.split('\n').length).toBeLessThanOrEqual(COLUMN_LINES)
    );
  });

  it('keeps account lines full width, since they carry structure', () => {
    const messages = buildBreakdownMessages({ guild: { name: 'Apex' }, split: SPLIT });
    const onDiscord = allFields(messages).find(field => field.name.includes('On Discord'));

    expect(onDiscord.inline).toBe(false);
  });

  describe('a full guild roster', () => {
    // 60 accounts with alts, 150 unclaimed characters, and 40 server members
    // with nothing on the roster — roughly the size of a real guild.
    const onDiscord = [];
    for (let person = 0; person < 60; person += 1) {
      for (let alt = 0; alt <= person % 3; alt += 1) {
        onDiscord.push({ name: `Char${person}_${alt}`, userId: `user${person}`, level: 70 });
      }
    }

    const split = {
      onDiscord,
      left: Array.from({ length: 5 }, (_, i) => ({
        name: `Gone${i}`,
        userId: `old${i}`,
        level: 70
      })),
      unlinked: Array.from({ length: 150 }, (_, i) => ({
        name: `Unclaimed${i}`,
        level: (i % 70) + 1,
        className: 'Rogue'
      }))
    };

    const outsiders = Array.from({ length: 40 }, (_, i) => ({ id: `outsider${i}` }));

    const messages = buildBreakdownMessages({
      guild: { name: 'Apex' },
      split,
      outsiders,
      resolveMain: () => null
    });

    it('spills across several messages rather than truncating', () => {
      expect(messages.length).toBeGreaterThan(1);
    });

    it('lists every single person and character', () => {
      // The point of the DM is to work through the list, so nothing is dropped.
      const lines = allLines(messages);

      expect(lines.filter(line => line.startsWith('<@user'))).toHaveLength(60);
      expect(lines.filter(line => line.includes('Unclaimed'))).toHaveLength(150);
      expect(lines.filter(line => line.startsWith('<@outsider'))).toHaveLength(40);
    });

    it('never says "and N more"', () => {
      expect(allLines(messages).some(line => line.includes('more_'))).toBe(false);
    });

    it('stays inside every Discord limit', () => {
      messages.forEach(embeds => {
        expect(embeds.length).toBeLessThanOrEqual(10);
        expect(embeds.reduce((sum, embed) => sum + embedLength(embed), 0)).toBeLessThanOrEqual(6000);

        embeds.forEach(embed => {
          const json = embed.toJSON();

          expect(json.fields.length).toBeLessThanOrEqual(25);
          expect(embedLength(embed)).toBeLessThanOrEqual(6000);
          json.fields.forEach(field => expect(field.value.length).toBeLessThanOrEqual(1024));
        });
      });
    });

    it('puts the summary on the first message only', () => {
      const described = messages.flat().filter(embed => embed.toJSON().description);
      expect(described).toHaveLength(1);
    });
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

  it('sends every message, not just the first', async () => {
    loadSnapshot.mockReturnValue(snapshot(Array.from({ length: 400 }, (_, i) => `Character${i}`)));

    const fake = interaction();
    await handleComponent(fake);

    expect(fake.user.send.mock.calls.length).toBeGreaterThan(1);
    expect(said(fake)).toContain('messages');
  });

  it('falls back to the reply and follow-ups when DMs are closed', async () => {
    loadSnapshot.mockReturnValue(snapshot(Array.from({ length: 400 }, (_, i) => `Character${i}`)));

    const fake = interaction({ dmFails: true });
    await handleComponent(fake);

    expect(fake.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) })
    );
    // Nothing is lost just because somebody keeps their DMs shut.
    expect(fake.followUp).toHaveBeenCalled();
  });

  it('splits the roster using the links and the server member list', async () => {
    const fake = interaction();
    await handleComponent(fake);

    const embed = fake.user.send.mock.calls[0][0].embeds[0].toJSON();

    expect(embed.description).toContain('1 person');
  });

  it('names server members who hold no roster character', async () => {
    const fake = interaction();
    await handleComponent(fake);

    const messages = fake.user.send.mock.calls.map(call => call[0].embeds);

    expect(allLines(messages)).toContain('<@u9>');
  });

  it('says so when there is no stored roster yet', async () => {
    loadSnapshot.mockReturnValue(null);
    const fake = interaction();

    expect(await handleComponent(fake)).toBe(true);
    expect(said(fake)).toContain('no stored roster');
    expect(fake.user.send).not.toHaveBeenCalled();
  });

  it('still works when the member list cannot be read', async () => {
    const guild = {
      id: 'g1',
      members: {
        fetch: jest.fn(async () => {
          throw new Error('nope');
        })
      }
    };

    const fake = interaction({ guild });

    expect(await handleComponent(fake)).toBe(true);
    expect(fake.user.send).toHaveBeenCalled();
  });
});

describe('killTallyLine', () => {
  it('shows today, 7-day, and lifetime figures together, labelled and in that order', () => {
    const line = killTallyLine(
      { name: 'Judgement', surname: 'Judy', today: 12, last7: 40, lifetime: 500 },
      new Map()
    );

    expect(line).toBe('**Judgement Judy** — Today **+12** · 7-Day **+40** · Lifetime **500**');
  });

  it('shows a dash for an unknown figure rather than a false zero', () => {
    const line = killTallyLine(
      { name: 'Judgement', surname: 'Judy', today: null, last7: null, lifetime: 500 },
      new Map()
    );

    expect(line).toContain('Today **—**');
    expect(line).toContain('7-Day **—**');
  });

  it('relabels the first figure "This Week" on a weekly report cadence', () => {
    // Kill-history is only captured when a report persists — once a week for
    // a weekly guild — so calling that figure "Today" would be wrong.
    const line = killTallyLine(
      { name: 'Judgement', surname: 'Judy', today: 12, last7: 40, lifetime: 500 },
      new Map(),
      'weekly'
    );

    expect(line).toBe('**Judgement Judy** — This Week **+12** · 7-Day **+40** · Lifetime **500**');
  });
});

describe('buildKillTallyMessages', () => {
  it('lists every member with all three figures', () => {
    const messages = buildKillTallyMessages({
      guild: { name: 'Apex' },
      tally: [{ name: 'Judgement', surname: 'Judy', today: 12, last7: 40, lifetime: 500 }]
    });

    expect(allLines(messages)).toContain(
      '**Judgement Judy** — Today **+12** · 7-Day **+40** · Lifetime **500**'
    );
  });

  it('keeps the column header in the same order as the lines', () => {
    const messages = buildKillTallyMessages({
      guild: { name: 'Apex' },
      tally: [{ name: 'Judgement', surname: 'Judy', today: 12, last7: 40, lifetime: 500 }]
    });

    const header = allFields(messages).find(field => field.name.includes('Today'));
    expect(header.name).toBe('💀 Today · 7-Day · Lifetime');
  });

  it('relabels the column header "This Week" on a weekly report cadence', () => {
    const messages = buildKillTallyMessages({
      guild: { name: 'Apex' },
      tally: [{ name: 'Judgement', surname: 'Judy', today: 12, last7: 40, lifetime: 500 }],
      frequency: 'weekly'
    });

    const header = allFields(messages).find(field => field.name.includes('This Week'));
    expect(header.name).toBe('💀 This Week · 7-Day · Lifetime');
    expect(allLines(messages)).toContain(
      '**Judgement Judy** — This Week **+12** · 7-Day **+40** · Lifetime **500**'
    );
  });

  it('spills across messages rather than truncating, for a large guild', () => {
    const tally = Array.from({ length: 400 }, (_, i) => ({
      name: `Char${i}`,
      surname: 'Smith',
      today: 1,
      last7: 1,
      lifetime: 1
    }));

    const messages = buildKillTallyMessages({ guild: { name: 'Apex' }, tally });

    expect(messages.length).toBeGreaterThan(1);
    expect(allLines(messages).filter(line => line.includes('Char'))).toHaveLength(400);
  });
});

describe('handleComponent — kill tally', () => {
  function killSnapshot() {
    return {
      guild: { name: 'Apex' },
      capturedAt: 2000,
      members: {
        judgement: { name: 'Judgement', surname: 'Judy', className: 'Paladin', kills: 500 },
        stranger: { name: 'Stranger', surname: 'Smith', className: 'Rogue', kills: 50 }
      }
    };
  }

  function killInteraction(overrides = {}) {
    return interaction({ customId: `${KILL_TALLY_BUTTON_PREFIX}${KEY}`, ...overrides });
  }

  beforeEach(() => {
    loadSnapshot.mockReturnValue(killSnapshot());
    loadKillHistory.mockReturnValue([
      { capturedAt: 1000, kills: { judgement: 480, stranger: 50 } },
      // Today's entry, already appended by the time the button can be pressed.
      { capturedAt: 2000, kills: { judgement: 500, stranger: 50 } }
    ]);
  });

  it('DMs the tally to whoever pressed the button', async () => {
    const fake = killInteraction();

    expect(await handleComponent(fake)).toBe(true);
    expect(fake.user.send).toHaveBeenCalled();
    expect(said(fake)).toContain('kill tally');
  });

  it("computes today's gain by dropping the already-appended latest entry", async () => {
    const fake = killInteraction();
    await handleComponent(fake);

    const lines = allLines(fake.user.send.mock.calls.map(call => call[0].embeds));
    expect(lines.some(line => line.includes('Judgement Judy') && line.includes('+20'))).toBe(true);
  });

  it('labels the figure "This Week" when the report cadence is weekly', async () => {
    loadConfig.mockReturnValue({ ...DEFAULTS, frequency: 'weekly' });
    const fake = killInteraction();
    await handleComponent(fake);

    const lines = allLines(fake.user.send.mock.calls.map(call => call[0].embeds));
    expect(lines.some(line => line.includes('Judgement Judy') && line.includes('This Week'))).toBe(
      true
    );
  });

  it('says so when there is no stored roster yet', async () => {
    loadSnapshot.mockReturnValue(null);
    const fake = killInteraction();

    expect(await handleComponent(fake)).toBe(true);
    expect(said(fake)).toContain('no stored roster');
    expect(fake.user.send).not.toHaveBeenCalled();
  });

  it('says so when nobody has recorded kills yet', async () => {
    loadSnapshot.mockReturnValue({ guild: { name: 'Apex' }, capturedAt: 2000, members: {} });
    loadKillHistory.mockReturnValue([]);
    const fake = killInteraction();

    await handleComponent(fake);
    expect(said(fake)).toContain('No member');
    expect(fake.user.send).not.toHaveBeenCalled();
  });

  it('falls back to the reply when DMs are closed', async () => {
    const fake = killInteraction({ dmFails: true });
    await handleComponent(fake);

    expect(fake.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) })
    );
  });
});
