const { describeGuilds, guildScopeWarnings } = require('../../utils/guildScope');

const guild = (id, name) => ({ id, name });

describe('describeGuilds', () => {
  it('names each guild with its id', () => {
    expect(describeGuilds([guild('1', 'Alpha'), guild('2', 'Beta')])).toBe('Alpha [1], Beta [2]');
  });

  it('says so when the bot is in none', () => {
    expect(describeGuilds([])).toContain('not been invited');
  });
});

describe('guildScopeWarnings', () => {
  it('stays quiet when the bot is only in the configured guild', () => {
    expect(guildScopeWarnings([guild('g1', 'Home')], 'g1')).toEqual([]);
  });

  it('stays quiet when no guild is configured', () => {
    expect(guildScopeWarnings([guild('g1', 'Home'), guild('g2', 'Other')], null)).toEqual([]);
  });

  it('names the guilds a pinned instance is ignoring', () => {
    const warnings = guildScopeWarnings([guild('g1', 'Home'), guild('g2', 'Other')], 'g1').join(' ');

    expect(warnings).toContain('1 other guild(s)');
    expect(warnings).toContain('Other [g2]');
    // Those guilds get no response unless another instance covers them.
    expect(warnings).toContain('Another instance must serve those');
  });

  it('warns when the configured guild has not been joined', () => {
    const warnings = guildScopeWarnings([guild('g2', 'Other')], 'g1').join(' ');

    expect(warnings).toContain('not a guild this bot has joined');
  });

  it('handles a bot in no guilds at all', () => {
    expect(guildScopeWarnings([], 'g1')).toEqual([]);
  });
});

describe('isGuildInScope', () => {
  const { isGuildInScope } = require('../../utils/guildScope');

  it('serves every guild when none is configured', () => {
    expect(isGuildInScope('anything', null)).toBe(true);
    expect(isGuildInScope('other', '')).toBe(true);
  });

  it('serves only the configured guild when one is set', () => {
    expect(isGuildInScope('g1', 'g1')).toBe(true);
    expect(isGuildInScope('g2', 'g1')).toBe(false);
  });

  it('never treats a DM as in scope', () => {
    expect(isGuildInScope(null, null)).toBe(false);
    expect(isGuildInScope(undefined, 'g1')).toBe(false);
  });
});
