const detector = require('../../../utils/spam/detector');
const state = require('../../../utils/spam/state');
const { normalizeConfig } = require('../../../utils/spam/config');
const { createMember, createMessage, DAY_MS } = require('../../helpers/message');

const config = normalizeConfig({});

beforeEach(() => state.clearAllState());

const record = (overrides = {}) =>
  state.record({
    guildId: 'g1',
    userId: 'u1',
    channelId: 'c1',
    content: 'a long enough message',
    ...overrides
  });

describe('checkRateLimit', () => {
  it('fires on the Nth message, not the N+1th', () => {
    for (let i = 0; i < 4; i += 1) record({ now: 1000 + i });

    expect(
      detector.checkRateLimit({ guildId: 'g1', userId: 'u1', count: 5, windowMs: 5000, now: 1010 })
    ).toBe(false);

    record({ now: 1005 });

    expect(
      detector.checkRateLimit({ guildId: 'g1', userId: 'u1', count: 5, windowMs: 5000, now: 1010 })
    ).toBe(true);
  });

  it('ignores messages outside the window', () => {
    for (let i = 0; i < 5; i += 1) record({ now: 1000 + i });

    expect(
      detector.checkRateLimit({ guildId: 'g1', userId: 'u1', count: 5, windowMs: 5000, now: 20000 })
    ).toBe(false);
  });
});

describe('checkDuplicates', () => {
  it('fires once the same text repeats to the threshold', () => {
    const content = 'buy my product now please';
    for (let i = 0; i < 3; i += 1) record({ content, now: 1000 + i });

    expect(
      detector.checkDuplicates({
        guildId: 'g1',
        userId: 'u1',
        content,
        threshold: 3,
        windowMs: 60000,
        now: 1100
      })
    ).toBe(true);
  });

  it('ignores short content, so repeated "lol" is not spam', () => {
    for (let i = 0; i < 5; i += 1) record({ content: 'lol', now: 1000 + i });

    expect(
      detector.checkDuplicates({
        guildId: 'g1',
        userId: 'u1',
        content: 'lol',
        threshold: 3,
        windowMs: 60000,
        now: 1100
      })
    ).toBe(false);
  });

  it('treats case and spacing differences as the same message', () => {
    record({ content: 'Buy   My PRODUCT now', now: 1000 });
    record({ content: 'buy my product now', now: 1001 });
    record({ content: 'BUY MY PRODUCT NOW', now: 1002 });

    expect(
      detector.checkDuplicates({
        guildId: 'g1',
        userId: 'u1',
        content: 'buy my product now',
        threshold: 3,
        windowMs: 60000,
        now: 1100
      })
    ).toBe(true);
  });
});

describe('checkCrossChannel', () => {
  it('fires when the same text appears in enough distinct channels', () => {
    const content = 'come visit my cool website';
    record({ content, channelId: 'c1', now: 1000 });
    record({ content, channelId: 'c2', now: 1001 });

    expect(
      detector.checkCrossChannel({
        guildId: 'g1',
        userId: 'u1',
        content,
        threshold: 2,
        windowMs: 60000,
        now: 1100
      })
    ).toBe(true);
  });

  it('does not fire for repeats in a single channel', () => {
    const content = 'come visit my cool website';
    record({ content, channelId: 'c1', now: 1000 });
    record({ content, channelId: 'c1', now: 1001 });

    expect(
      detector.checkCrossChannel({
        guildId: 'g1',
        userId: 'u1',
        content,
        threshold: 2,
        windowMs: 60000,
        now: 1100
      })
    ).toBe(false);
  });
});

describe('checkMentions', () => {
  it('adds users and roles together', () => {
    expect(detector.checkMentions(createMessage({ mentionedUsers: 3, mentionedRoles: 2 }), 5)).toBe(true);
    expect(detector.checkMentions(createMessage({ mentionedUsers: 3, mentionedRoles: 1 }), 5)).toBe(false);
  });

  it('tolerates a message with no mentions object', () => {
    expect(detector.checkMentions({}, 5)).toBe(false);
  });
});

describe('getTrustTier', () => {
  it.each([
    ['brand-new account', 1, 1, detector.TRUST.SUSPICIOUS],
    ['old account, joined today', 400, 0.5, detector.TRUST.SUSPICIOUS],
    ['ordinary member', 60, 10, detector.TRUST.STANDARD],
    ['long-standing member', 400, 60, detector.TRUST.ESTABLISHED]
  ])('classifies %s', (_label, accountDays, tenureDays, expected) => {
    const member = createMember({ accountDays, tenureDays });
    expect(detector.getTrustTier(member, config)).toBe(expected);
  });

  it('treats an unknown join date as suspicious, which is the safe direction', () => {
    const member = createMember({ accountDays: 400, tenureDays: null });
    expect(detector.getTrustTier(member, config)).toBe(detector.TRUST.SUSPICIOUS);
  });

  it('is not "new" exactly at the account-age boundary', () => {
    const now = Date.now();
    const member = {
      user: { createdTimestamp: now - config.newAccountDays * DAY_MS },
      joinedTimestamp: now - 10 * DAY_MS
    };

    expect(detector.getTrustTier(member, config, now)).toBe(detector.TRUST.STANDARD);
  });

  it('is established exactly at the tenure boundary', () => {
    const now = Date.now();
    const member = {
      user: { createdTimestamp: now - 400 * DAY_MS },
      joinedTimestamp: now - config.establishedDays * DAY_MS
    };

    expect(detector.getTrustTier(member, config, now)).toBe(detector.TRUST.ESTABLISHED);
  });
});

describe('getRequiredSignals', () => {
  it('gives new accounts no benefit of the doubt', () => {
    expect(detector.getRequiredSignals(detector.TRUST.SUSPICIOUS, 2)).toBe(1);
  });

  it('uses the configured threshold for ordinary members', () => {
    expect(detector.getRequiredSignals(detector.TRUST.STANDARD, 2)).toBe(2);
  });

  it('demands one more from established members', () => {
    expect(detector.getRequiredSignals(detector.TRUST.ESTABLISHED, 2)).toBe(3);
  });
});

describe('collectSignals', () => {
  it('reports every distinct red flag', () => {
    const content = 'free nitro claim your free crypto airdrop wallet discord.gg/abc';
    record({ content, now: 1000 });

    const message = createMessage({ content, mentionedUsers: 6 });
    const signals = detector.collectSignals({ message, config, now: 1000 });

    expect(signals).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Nitro/gift card scam'),
        expect.stringContaining('crypto/NFT scam'),
        expect.stringContaining('mass mention'),
        'Discord invite link'
      ])
    );
  });

  it('returns nothing for ordinary chat', () => {
    const content = 'anyone want to run Kara tonight?';
    record({ content, now: 1000 });

    expect(
      detector.collectSignals({ message: createMessage({ content }), config, now: 1000 })
    ).toEqual([]);
  });
});

describe('collectContentSignals', () => {
  it('covers content signals only, ignoring rate and repetition', () => {
    for (let i = 0; i < 10; i += 1) record({ now: 1000 + i });

    const signals = detector.collectContentSignals({
      message: createMessage({ content: 'free nitro here' }),
      config
    });

    expect(signals).toEqual([expect.stringContaining('Nitro/gift card scam')]);
  });
});

describe('decide', () => {
  const signals = n => Array.from({ length: n }, (_, i) => `flag ${i}`);

  it('acts on a new account after a single flag', () => {
    const decision = detector.decide({ tier: detector.TRUST.SUSPICIOUS, signals: signals(1), config });

    expect(decision).toMatchObject({ verdict: 'spam', action: 'ban', reasonPrefix: 'Spam detection' });
  });

  it('ignores an ordinary member with one flag', () => {
    expect(detector.decide({ tier: detector.TRUST.STANDARD, signals: signals(1), config })).toBeNull();
  });

  it('acts on an ordinary member at the threshold', () => {
    expect(
      detector.decide({ tier: detector.TRUST.STANDARD, signals: signals(2), config })
    ).toMatchObject({ verdict: 'spam', action: 'ban' });
  });

  it('times out an established member in the compromise band', () => {
    const decision = detector.decide({
      tier: detector.TRUST.ESTABLISHED,
      signals: signals(2),
      config
    });

    expect(decision).toMatchObject({
      verdict: 'compromise',
      action: 'timeout',
      reasonPrefix: 'Possible account compromise'
    });
  });

  it('bans an established member once they clear the raised bar', () => {
    expect(
      detector.decide({ tier: detector.TRUST.ESTABLISHED, signals: signals(3), config })
    ).toMatchObject({ verdict: 'spam', action: 'ban' });
  });

  it('ignores an established member with one flag', () => {
    expect(
      detector.decide({ tier: detector.TRUST.ESTABLISHED, signals: signals(1), config })
    ).toBeNull();
  });
});

describe('buildReason', () => {
  it('records the tier and every flag for the audit log', () => {
    expect(
      detector.buildReason({
        reasonPrefix: 'Spam detection',
        tier: 'suspicious',
        signals: ['rate limit (5 msgs / 5s)', 'Discord invite link']
      })
    ).toBe('Spam detection [suspicious]: rate limit (5 msgs / 5s); Discord invite link');
  });
});

describe('age helpers', () => {
  it('reports whole days', () => {
    const member = createMember({ accountDays: 10.7, tenureDays: 3.2 });

    expect(detector.accountAgeDays(member)).toBe(10);
    expect(detector.tenureDays(member)).toBe(3);
  });

  it('reports zero when timestamps are missing', () => {
    expect(detector.accountAgeDays({})).toBe(0);
    expect(detector.tenureDays({})).toBe(0);
  });
});
