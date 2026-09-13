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

  it('warns about extra guilds, because GUILD_ID does not scope them', () => {
    const warnings = guildScopeWarnings([guild('g1', 'Home'), guild('g2', 'Other')], 'g1').join(' ');

    expect(warnings).toContain('1 other guild(s)');
    expect(warnings).toContain('Other [g2]');
    expect(warnings).toContain('does NOT stop this process');
    expect(warnings).toContain('separate Discord application');
  });

  it('warns when the configured guild has not been joined', () => {
    const warnings = guildScopeWarnings([guild('g2', 'Other')], 'g1').join(' ');

    expect(warnings).toContain('not a guild this bot has joined');
  });

  it('handles a bot in no guilds at all', () => {
    expect(guildScopeWarnings([], 'g1')).toEqual([]);
  });
});
