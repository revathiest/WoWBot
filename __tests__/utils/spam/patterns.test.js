const { SPAM_PATTERNS, hasInviteLink, matchPatterns } = require('../../../utils/spam/patterns');

describe('matchPatterns — positives', () => {
  it.each([
    ['free nitro for the first 100 users', 'Nitro/gift card scam'],
    ['NITRO GIVEAWAY click here', 'Nitro/gift card scam'],
    ['free steam gift card here', 'Nitro/gift card scam'],
    ['claim your free crypto now', 'crypto/NFT scam'],
    ['free bitcoin for everyone', 'crypto/NFT scam'],
    ['send to 0x1234567890abcdef1234567890abcdef12345678', 'crypto/NFT scam'],
    ['airdrop live now, connect your wallet', 'crypto/NFT scam'],
    ['check https://bit.ly/xyz for details', 'URL shortener'],
    ['join my discord for more', 'server promotion'],
    ['join our server today', 'server promotion'],
    ['earn $500 per day from home', 'get-rich-quick'],
    ['make $1000/day guaranteed', 'get-rich-quick']
  ])('flags %s as %s', (text, expected) => {
    expect(matchPatterns(text)).toContain(expected);
  });

  it('counts each matching category separately', () => {
    const categories = matchPatterns('free nitro and free crypto, earn $900 per day');

    expect(categories).toEqual(
      expect.arrayContaining(['Nitro/gift card scam', 'crypto/NFT scam', 'get-rich-quick'])
    );
    expect(categories.length).toBeGreaterThanOrEqual(3);
  });
});

describe('matchPatterns — negatives', () => {
  // These are the false positives that make a spam filter hated. Each one is a
  // plausible sentence in a WoW or sci-fi guild.
  it.each([
    'the enemy did an airdrop on our position',
    'we got an airdrop of supplies last night',
    'join our raid group, we need a healer',
    'join the guild discord voice chat in 10',
    'check out https://www.wowhead.com/tbc/item=32837',
    'I make $5 per day doing world quests',
    'that boss drops a free trinket',
    'anyone want to run heroics tonight?',
    ''
  ])('does not flag %s', text => {
    expect(matchPatterns(text)).toEqual([]);
  });

  it('ignores nullish input', () => {
    expect(matchPatterns(undefined)).toEqual([]);
    expect(matchPatterns(null)).toEqual([]);
  });
});

describe('hasInviteLink', () => {
  it.each([
    'come to discord.gg/abc123',
    'https://discord.com/invite/xyz789',
    'https://discordapp.com/invite/legacy1'
  ])('detects %s', text => {
    expect(hasInviteLink(text)).toBe(true);
  });

  it.each([
    'discord is down again',
    'see the discord channel',
    'https://wowhead.com/item=1',
    ''
  ])('does not flag %s', text => {
    expect(hasInviteLink(text)).toBe(false);
  });
});

describe('SPAM_PATTERNS shape', () => {
  it('exposes five categories, each a non-empty list of regexes', () => {
    const entries = Object.entries(SPAM_PATTERNS);

    expect(entries).toHaveLength(5);
    entries.forEach(([, patterns]) => {
      expect(patterns.length).toBeGreaterThan(0);
      patterns.forEach(pattern => expect(pattern).toBeInstanceOf(RegExp));
    });
  });
});
