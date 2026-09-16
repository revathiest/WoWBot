const {
  MAX_FIELD_LENGTH,
  buildPreviewEmbed,
  buildSweepEmbed,
  kickMessage,
  listField,
  memberLine,
  plural,
  sendAlert,
  warningMessage
} = require('../../../utils/onboarding/alert');
const { DAY_MS } = require('../../../utils/onboarding/classify');

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

function config(overrides = {}) {
  return { enabled: true, graceDays: 7, warnAfterDays: 5, roleChannelId: null, ...overrides };
}

function member(id, { days = 8, dmDelivered = true } = {}) {
  return {
    id,
    tag: `${id}#0001`,
    daysInServer: days,
    joinedTimestamp: NOW - days * DAY_MS,
    dmDelivered
  };
}

function field(embed, prefix) {
  return (embed.toJSON().fields ?? []).find(entry => entry.name.startsWith(prefix));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('plural', () => {
  it('keeps one singular', () => expect(plural(1, 'day')).toBe('1 day'));
  it('pluralises everything else', () => expect(plural(3, 'day')).toBe('3 days'));
  it('pluralises zero', () => expect(plural(0, 'day')).toBe('0 days'));
});

describe('listField', () => {
  it('says so when there is nothing', () => expect(listField([])).toBe('_none_'));

  it('stays inside Discord\'s field limit', () => {
    const lines = Array.from({ length: 40 }, () => 'x'.repeat(300));
    expect(listField(lines).length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
  });

  it('reports what it dropped', () => {
    expect(listField(Array.from({ length: 40 }, (_, i) => `line ${i}`))).toContain('more');
  });
});

describe('memberLine', () => {
  it('shows whole days in the server', () => {
    expect(memberLine(member('bob', { days: 8.7 }))).toBe('• `bob#0001` — 8d in server');
  });

  it('copes with an unknown duration', () => {
    expect(memberLine({ tag: 'x#1', daysInServer: null })).toContain('?');
  });
});

describe('warningMessage', () => {
  it('links the role picker when one is configured', () => {
    const text = warningMessage({ guildName: 'Guild', daysLeft: 2, roleChannelId: 'c1' });
    expect(text).toContain('<#c1>');
  });

  it('still reads sensibly without a role channel', () => {
    const text = warningMessage({ guildName: 'Guild', daysLeft: 2, roleChannelId: null });

    expect(text).toContain('pick your roles in the server');
    expect(text).not.toContain('<#');
  });

  it('says exactly how long is left, and that rejoining is allowed', () => {
    const text = warningMessage({ guildName: 'Guild', daysLeft: 1 });

    expect(text).toContain('1 day');
    expect(text).toContain('rejoin');
  });
});

describe('kickMessage', () => {
  it('explains why, and makes clear it is not a ban', () => {
    const text = kickMessage({ guildName: 'Guild', graceDays: 7 });

    expect(text).toContain('7 days');
    expect(text).toContain('not a ban');
  });
});

describe('buildSweepEmbed', () => {
  it('lists who was removed', () => {
    const embed = buildSweepEmbed({ kicked: [member('bob')], config: config() });
    expect(field(embed, '🔨 Removed').value).toContain('bob#0001');
  });

  it('lists who was reminded', () => {
    const embed = buildSweepEmbed({ warned: [member('bob', { days: 6 })], config: config() });
    expect(field(embed, '📨 Reminded').value).toContain('bob#0001');
  });

  it('flags an undeliverable DM rather than implying the member was told', () => {
    const embed = buildSweepEmbed({ kicked: [member('bob', { dmDelivered: false })], config: config() });
    expect(field(embed, '🔨 Removed').value).toContain('DM undeliverable');
  });

  it('calls out kicks that were blocked', () => {
    const embed = buildSweepEmbed({
      blocked: [{ tag: 'mod#0001', reason: 'the target has a role ranked at or above the bot' }],
      config: config()
    });

    expect(field(embed, '⚠️ Could not remove').value).toContain('above the bot');
  });

  it('explains a capped sweep', () => {
    const embed = buildSweepEmbed({ kicked: [member('bob')], capped: true, config: config() });
    expect(field(embed, '🛑 Sweep capped')).toBeDefined();
  });

  it('says plainly when nothing happened', () => {
    expect(buildSweepEmbed({ config: config() }).toJSON().description).toContain('Nobody');
  });

  it('marks a dry run, so it cannot be mistaken for real removals', () => {
    const embed = buildSweepEmbed({ kicked: [member('bob')], config: config(), dryRun: true });

    expect(embed.toJSON().title).toContain('Dry Run');
    expect(embed.toJSON().description).toContain('Nothing actually happened');
  });

  it('records the settings in force at the time', () => {
    const embed = buildSweepEmbed({ config: config({ graceDays: 10, warnAfterDays: 3 }) });
    expect(embed.toJSON().footer.text).toBe('Grace 10d • reminder at 3d');
  });
});

describe('buildPreviewEmbed', () => {
  const base = { kick: [], warn: [], waiting: [], exempt: [], config: config(), now: NOW };

  it('leads with the counts', () => {
    const embed = buildPreviewEmbed({ ...base, kick: [member('a')], warn: [member('b', { days: 6 })] });

    expect(field(embed, 'Would be removed').value).toBe('1');
    expect(field(embed, 'Would be reminded').value).toBe('1');
  });

  it('warns that nothing will happen while the sweep is off', () => {
    const embed = buildPreviewEmbed({ ...base, config: config({ enabled: false }) });
    expect(embed.toJSON().description).toContain('**off**');
  });

  it('counts down for members still choosing', () => {
    const embed = buildPreviewEmbed({ ...base, waiting: [member('bob', { days: 2 })] });
    expect(field(embed, '⏳ Still choosing').value).toContain('5 days left');
  });

  it('explains an empty preview caused by the cutoff', () => {
    // Otherwise "0 would be removed" looks broken in a server full of
    // roleless members.
    const embed = buildPreviewEmbed({
      ...base,
      exempt: [{ tag: 'old#0001', reason: 'joined before the sweep was switched on' }]
    });

    expect(field(embed, 'Protected by the cutoff').value).toContain('1 member');
  });

  it('does not mention the cutoff when it is not the reason', () => {
    const embed = buildPreviewEmbed({ ...base, exempt: [{ tag: 'bot#1', reason: 'a bot' }] });
    expect(field(embed, 'Protected by the cutoff')).toBeUndefined();
  });
});

describe('sendAlert', () => {
  function clientWith(channel) {
    return { channels: { fetch: jest.fn(async () => channel) } };
  }

  it('posts to the configured channel', async () => {
    const send = jest.fn(async () => {});
    const client = clientWith({ isTextBased: () => true, send });

    expect(await sendAlert({ client, channelId: 'c1', embed: {} })).toBe(true);
    expect(send).toHaveBeenCalled();
  });

  it('warns when no channel is configured', async () => {
    expect(await sendAlert({ client: clientWith(null), channelId: null, embed: {} })).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it('refuses a channel that is not text-based', async () => {
    const client = clientWith({ isTextBased: () => false });
    expect(await sendAlert({ client, channelId: 'c1', embed: {} })).toBe(false);
  });

  it('swallows a failure rather than letting it undo a sweep', async () => {
    const client = { channels: { fetch: jest.fn(async () => { throw new Error('Missing Access'); }) } };

    expect(await sendAlert({ client, channelId: 'c1', embed: {} })).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });
});
