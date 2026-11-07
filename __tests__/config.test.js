const {
  REGIONS,
  GAME_INFIX,
  DEFAULT_REGION,
  DEFAULT_LOCALE,
  buildNamespace,
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
      guildId: '456',
      // Locked by default; see PUBLIC_COMMANDS for the revert.
      adminOnly: true
    });
    // No `game` and no `realm`: this bot serves one flavour, Classic Forever,
    // which has neither a picker nor a realm concept.
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

describe('buildNamespace', () => {
  it('always inserts the forever infix — this bot serves one flavour', () => {
    expect(buildNamespace('profile', 'us')).toBe('profile-forever-us');
    expect(buildNamespace('dynamic', 'eu')).toBe('dynamic-forever-eu');
    expect(buildNamespace('static', 'kr')).toBe('static-forever-kr');
  });

  it('exports the infix as a named constant', () => {
    expect(GAME_INFIX).toBe('forever');
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

describe('admin-only lockdown', () => {
  const { PUBLIC_COMMANDS, readAdminOnly, readConfig: readConfig2 } = require('../config');

  it('is on by default, so a fresh deploy is locked', () => {
    expect(readAdminOnly({})).toBe(true);
    expect(readConfig2({}).discord.adminOnly).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no'])('is lifted by ADMIN_ONLY=%s', value => {
    expect(readAdminOnly({ ADMIN_ONLY: value })).toBe(false);
  });

  it('stays on for anything else, rather than unlocking by accident', () => {
    expect(readAdminOnly({ ADMIN_ONLY: 'yes' })).toBe(true);
    expect(readAdminOnly({ ADMIN_ONLY: 'nonsense' })).toBe(true);
  });

  it('records the commands that were public, as the undo list', () => {
    // This list is how the lock gets reverted; losing it means reconstructing
    // it from memory. Shorter than it once was — /token, /arena and
    // /mythicplus were removed outright, since Classic Forever has none of
    // what they needed.
    expect(PUBLIC_COMMANDS).toEqual([
      'audit',
      'character',
      'guild',
      'help',
      'iam',
      'item',
      'realm',
      'realms'
    ]);
  });
});

describe('namespace watch configuration', () => {
  it('takes a probe character and lowercases it', () => {
    const config = readConfig({ NAMESPACE_WATCH_CHARACTER: '  Judgement-Judy  ' });
    expect(config.namespaceWatch.character).toBe('judgement-judy');
  });

  it('leaves the probe character null when unset, so that check is skipped', () => {
    // There is no safe default: an invented name 404s under a healthy namespace
    // exactly as it does under a broken one.
    expect(readConfig({}).namespaceWatch.character).toBeNull();
  });
});
