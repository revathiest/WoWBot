const {
  REGIONS,
  GAMES,
  DEFAULT_REGION,
  DEFAULT_LOCALE,
  DEFAULT_GAME,
  buildNamespace,
  normalizeGame,
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
  BLIZZARD_LOCALE: 'en_GB',
  BLIZZARD_GAME: 'classic'
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
      locale: 'en_GB',
      game: 'classic'
    });
  });

  it('falls back to defaults for region, locale, and game', () => {
    const config = readConfig({
      BLIZZARD_REGION: 'nonsense',
      BLIZZARD_LOCALE: '   ',
      BLIZZARD_GAME: 'wrath'
    });

    expect(config.blizzard.region).toBe(DEFAULT_REGION);
    expect(config.blizzard.locale).toBe(DEFAULT_LOCALE);
    expect(config.blizzard.game).toBe(DEFAULT_GAME);
  });

  it('treats a blank guild id as absent, so commands register globally', () => {
    expect(readConfig({ GUILD_ID: '   ' }).discord.guildId).toBeNull();
    expect(readConfig({}).discord.guildId).toBeNull();
  });
});

describe('normalizeGame', () => {
  it('accepts every supported game version', () => {
    Object.keys(GAMES).forEach(game => {
      expect(normalizeGame(game)).toBe(game);
      expect(normalizeGame(` ${game.toUpperCase()} `)).toBe(game);
    });
  });

  it('rejects expansions that are not separate namespaces', () => {
    // Blizzard exposes only retail, classic, and classic1x -- there is no
    // per-expansion namespace, verified by probing (everything else 403s).
    ['tbc', 'wrath', 'cata', 'mop', 'classic2x', ''].forEach(value => {
      expect(normalizeGame(value)).toBeNull();
    });
  });
});

describe('buildNamespace', () => {
  it('omits the infix for retail', () => {
    expect(buildNamespace('profile', 'retail', 'us')).toBe('profile-us');
    expect(buildNamespace('dynamic', undefined, 'eu')).toBe('dynamic-eu');
  });

  it('inserts the classic infixes', () => {
    expect(buildNamespace('dynamic', 'classic', 'us')).toBe('dynamic-classic-us');
    expect(buildNamespace('static', 'classic-era', 'us')).toBe('static-classic1x-us');
    expect(buildNamespace('profile', 'classic', 'eu')).toBe('profile-classic-eu');
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
