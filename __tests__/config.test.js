const {
  REGIONS,
  DEFAULT_REGION,
  DEFAULT_LOCALE,
  normalizeRegion,
  readConfig,
  validateConfig
} = require('../config');

const FULL_ENV = {
  DISCORD_TOKEN: 'discord-token',
  APPLICATION_ID: '123',
  GUILD_ID: '456',
  BLIZZARD_CLIENT_ID: 'client-id',
  BLIZZARD_CLIENT_SECRET: 'client-secret',
  BLIZZARD_REGION: 'eu',
  BLIZZARD_LOCALE: 'en_GB'
};

describe('normalizeRegion', () => {
  it('accepts every supported region regardless of casing or padding', () => {
    REGIONS.forEach(region => {
      expect(normalizeRegion(region.toUpperCase())).toBe(region);
      expect(normalizeRegion(`  ${region}  `)).toBe(region);
    });
  });

  it('returns null for unsupported or missing values', () => {
    expect(normalizeRegion('cn')).toBeNull();
    expect(normalizeRegion('')).toBeNull();
    expect(normalizeRegion(undefined)).toBeNull();
  });
});

describe('readConfig', () => {
  it('reads every value from the environment', () => {
    const config = readConfig(FULL_ENV);

    expect(config.discord).toEqual({
      token: 'discord-token',
      applicationId: '123',
      guildId: '456'
    });
    expect(config.blizzard).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      region: 'eu',
      locale: 'en_GB'
    });
  });

  it('falls back to defaults for region and locale', () => {
    const config = readConfig({ BLIZZARD_REGION: 'nonsense', BLIZZARD_LOCALE: '   ' });

    expect(config.blizzard.region).toBe(DEFAULT_REGION);
    expect(config.blizzard.locale).toBe(DEFAULT_LOCALE);
  });

  it('treats a blank guild id as absent, so commands register globally', () => {
    expect(readConfig({ GUILD_ID: '   ' }).discord.guildId).toBeNull();
    expect(readConfig({}).discord.guildId).toBeNull();
  });
});

describe('validateConfig', () => {
  it('reports nothing when the required values are present', () => {
    expect(validateConfig(readConfig(FULL_ENV))).toEqual([]);
  });

  it('does not require a guild id', () => {
    const { GUILD_ID, ...withoutGuild } = FULL_ENV;
    expect(validateConfig(readConfig(withoutGuild))).toEqual([]);
  });

  it('names each missing required value', () => {
    const problems = validateConfig(readConfig({}));

    expect(problems).toHaveLength(4);
    expect(problems.join(' ')).toContain('DISCORD_TOKEN');
    expect(problems.join(' ')).toContain('APPLICATION_ID');
    expect(problems.join(' ')).toContain('BLIZZARD_CLIENT_ID');
    expect(problems.join(' ')).toContain('BLIZZARD_CLIENT_SECRET');
  });
});
