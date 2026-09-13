const {
  COLOR_BAN,
  COLOR_BLOCKED,
  COLOR_TIMEOUT,
  buildAlertEmbed,
  describeAction,
  formatDuration,
  sendAlert,
  truncate
} = require('../../../utils/spam/alert');
const { createMessage } = require('../../helpers/message');
const { field } = require('../../helpers/interaction');

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

describe('formatDuration', () => {
  it.each([
    [3600000, '1h'],
    [2700000, '45m'],
    [9000000, '2h 30m'],
    [0, '0m']
  ])('renders %sms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('truncate', () => {
  it('passes short text through', () => {
    expect(truncate('hello')).toBe('hello');
  });

  it('marks empty content rather than producing an invalid field', () => {
    expect(truncate('   ')).toBe('*(no text content)*');
  });

  it('cuts long text to the limit', () => {
    const result = truncate('x'.repeat(2000));
    expect(result).toHaveLength(1024);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('describeAction', () => {
  it('describes a ban and a timeout', () => {
    expect(describeAction({ action: 'ban', acted: true })).toBe('🔨 Banned');
    expect(describeAction({ action: 'timeout', durationMs: 3600000, acted: true })).toBe(
      '⏱️ Timed out (1h)'
    );
  });

  it('says why nothing happened when blocked', () => {
    expect(
      describeAction({ action: 'ban', acted: false, blockedReason: 'the target is the server owner' })
    ).toBe('⚠️ No action — the target is the server owner');
  });
});

describe('buildAlertEmbed', () => {
  const base = {
    message: createMessage({ content: 'free nitro discord.gg/x' }),
    decision: { action: 'ban', durationMs: 3600000, verdict: 'spam' },
    outcome: { acted: true, deleted: true, blockedReason: null },
    tier: 'suspicious',
    signals: ['spam pattern: Nitro/gift card scam', 'Discord invite link'],
    accountAge: 0,
    tenure: 0
  };

  const build = (overrides = {}) =>
    buildAlertEmbed({ ...base, member: base.message.member, ...overrides }).toJSON();

  it('records everything needed to review the decision later', () => {
    const embed = build();

    expect(embed.title).toBe('Spam Detected');
    expect(embed.color).toBe(COLOR_BAN);
    expect(field(embed, 'Action').value).toBe('🔨 Banned');
    expect(field(embed, 'Trust Tier').value).toBe('suspicious');
    expect(field(embed, 'Message Deleted').value).toBe('Yes');
    expect(field(embed, 'Red Flags (2)').value).toContain('Nitro/gift card scam');
    expect(field(embed, 'Message').value).toContain('free nitro');
    expect(embed.timestamp).toBeDefined();
  });

  it('titles a compromise differently and uses the timeout colour', () => {
    const embed = build({
      decision: { action: 'timeout', durationMs: 3600000, verdict: 'compromise' }
    });

    expect(embed.title).toBe('Possible Account Compromise');
    expect(embed.color).toBe(COLOR_TIMEOUT);
  });

  it('greys out and explains an action that could not be taken', () => {
    const embed = build({
      outcome: { acted: false, deleted: false, blockedReason: 'the bot lacks the Ban Members permission' }
    });

    expect(embed.color).toBe(COLOR_BLOCKED);
    expect(field(embed, 'Action').value).toContain('lacks the Ban Members permission');
    expect(field(embed, 'Message Deleted').value).toBe('No');
  });
});

describe('sendAlert', () => {
  const embed = { toJSON: () => ({}) };

  it('posts to the configured channel', async () => {
    const send = jest.fn(async () => {});
    const client = { channels: { fetch: jest.fn(async () => ({ isTextBased: () => true, send })) } };

    await expect(sendAlert({ client, channelId: 'c9', embed })).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith({ embeds: [embed] });
  });

  it('warns and gives up when no channel is configured', async () => {
    await expect(sendAlert({ client: {}, channelId: null, embed })).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it('refuses a non-text channel', async () => {
    const client = { channels: { fetch: jest.fn(async () => ({ isTextBased: () => false })) } };

    await expect(sendAlert({ client, channelId: 'c9', embed })).resolves.toBe(false);
  });

  it('never lets a broken alert channel throw into enforcement', async () => {
    const client = { channels: { fetch: jest.fn(async () => { throw new Error('Unknown Channel'); }) } };

    await expect(sendAlert({ client, channelId: 'c9', embed })).resolves.toBe(false);
  });
});
