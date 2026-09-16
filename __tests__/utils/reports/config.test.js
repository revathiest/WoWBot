jest.mock('fs');

const fs = require('fs');
const {
  DAYS,
  DEFAULTS,
  MAX_TRACKED_GUILDS,
  channelFor,
  clearConfigCache,
  guildKey,
  loadConfig,
  normalizeConfig,
  normalizeGuild,
  saveConfig,
  trackGuild,
  untrackGuild
} = require('../../../utils/reports/config');

beforeEach(() => {
  jest.clearAllMocks();
  clearConfigCache();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

function fileContains(value) {
  fs.readFileSync.mockReturnValue(typeof value === 'string' ? value : JSON.stringify(value));
}

function fileMissing() {
  const err = new Error('no such file');
  err.code = 'ENOENT';
  fs.readFileSync.mockImplementation(() => {
    throw err;
  });
}

/** What the most recent saveConfig wrote. */
function written() {
  const calls = fs.writeFileSync.mock.calls;
  return JSON.parse(calls[calls.length - 1][1]);
}

const APEX = { name: 'Apex', realm: 'Nightslayer', region: 'us', game: 'anniversary' };

describe('normalizeConfig', () => {
  it('fills in every default for an empty object', () => {
    expect(normalizeConfig({})).toEqual(DEFAULTS);
  });

  it('ships disabled, so nothing posts until an admin says so', () => {
    expect(normalizeConfig({}).enabled).toBe(false);
  });

  it('survives junk without throwing', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULTS);
    expect(normalizeConfig('nonsense')).toEqual(DEFAULTS);
    expect(normalizeConfig(undefined)).toEqual(DEFAULTS);
  });

  it.each([
    ['a day below the floor', { dayOfWeek: -3 }, c => c.dayOfWeek, 0],
    ['a day above the ceiling', { dayOfWeek: 99 }, c => c.dayOfWeek, 6],
    ['an hour below the floor', { hour: -1 }, c => c.hour, 0],
    ['an hour above the ceiling', { hour: 48 }, c => c.hour, 23]
  ])('clamps %s', (_label, input, read, expected) => {
    expect(read(normalizeConfig(input))).toBe(expected);
  });

  it('rejects a nonsensical lastPostedAt rather than scheduling from it', () => {
    expect(normalizeConfig({ lastPostedAt: -5 }).lastPostedAt).toBeNull();
    expect(normalizeConfig({ lastPostedAt: 'soon' }).lastPostedAt).toBeNull();
  });

  it('drops guilds that have no name', () => {
    expect(normalizeConfig({ guilds: [{ realm: 'Nightslayer' }] }).guilds).toEqual([]);
  });

  it('keeps at most the tracked-guild ceiling', () => {
    const many = Array.from({ length: MAX_TRACKED_GUILDS + 5 }, (_, i) => ({
      name: `Guild${i}`,
      realm: 'Nightslayer'
    }));

    expect(normalizeConfig({ guilds: many }).guilds).toHaveLength(MAX_TRACKED_GUILDS);
  });

  it('treats guilds differing only by case and spacing as one', () => {
    const config = normalizeConfig({
      guilds: [
        { name: 'Apex', realm: 'Nightslayer' },
        { name: ' apex ', realm: 'nightslayer' }
      ]
    });

    expect(config.guilds).toHaveLength(1);
  });

  it('keeps same-named guilds on different realms apart', () => {
    const config = normalizeConfig({
      guilds: [
        { name: 'Apex', realm: 'Nightslayer' },
        { name: 'Apex', realm: 'Dreamscythe' }
      ]
    });

    expect(config.guilds).toHaveLength(2);
  });
});

describe('normalizeGuild', () => {
  it('falls back to the configured home realm', () => {
    // jest.setup.js pins BLIZZARD_REALM to Testrealm.
    expect(normalizeGuild({ name: 'Apex' }).realm).toBe('Testrealm');
  });

  it('falls back to the configured region and game', () => {
    expect(normalizeGuild({ name: 'Apex' })).toMatchObject({ region: 'us', game: 'retail' });
  });

  it('rejects an unknown region rather than sending it to Blizzard', () => {
    expect(normalizeGuild({ name: 'Apex', region: 'mars' }).region).toBe('us');
  });

  it('returns null when there is nothing usable', () => {
    expect(normalizeGuild({})).toBeNull();
    expect(normalizeGuild(null)).toBeNull();
  });
});

describe('guildKey', () => {
  it('folds case, punctuation, and accents the way realm matching does', () => {
    expect(guildKey({ name: "Knights' Watch", realm: 'Azjol-Nerub', region: 'us', game: 'retail' })).toBe(
      guildKey({ name: 'knights watch', realm: 'azjolnerub', region: 'US', game: 'retail' })
    );
  });

  it('separates the same guild name on different game versions', () => {
    expect(guildKey({ ...APEX, game: 'retail' })).not.toBe(guildKey({ ...APEX, game: 'anniversary' }));
  });
});

describe('loadConfig', () => {
  it('uses defaults when the file has never been written', () => {
    fileMissing();
    expect(loadConfig()).toEqual(DEFAULTS);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns but still returns defaults when the file is corrupt', () => {
    fs.readFileSync.mockReturnValue('{ not json');
    expect(loadConfig()).toEqual(DEFAULTS);
    expect(console.warn).toHaveBeenCalled();
  });

  it('caches, so repeated reads do not hit the disk', () => {
    fileContains({ enabled: true });
    loadConfig();
    loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('saveConfig', () => {
  it('writes atomically, via a temp file and a rename', () => {
    fileMissing();
    saveConfig({ hour: 9 });

    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('clamps on the way out, not just on the way in', () => {
    fileMissing();
    saveConfig({ hour: 99 });
    expect(written().hour).toBe(23);
  });

  it('merges rather than replacing', () => {
    fileContains({ enabled: true, channelId: '42' });
    saveConfig({ hour: 6 });

    expect(written()).toMatchObject({ enabled: true, channelId: '42', hour: 6 });
  });
});

describe('trackGuild', () => {
  it('adds a guild', () => {
    fileMissing();
    const result = trackGuild(APEX);

    expect(result.added).toBe(true);
    expect(written().guilds).toHaveLength(1);
  });

  it('refuses a duplicate instead of tracking it twice', () => {
    fileContains({ guilds: [APEX] });
    expect(trackGuild({ ...APEX, name: 'apex' })).toMatchObject({ added: false, reason: 'duplicate' });
  });

  it('refuses once the ceiling is reached', () => {
    fileContains({
      guilds: Array.from({ length: MAX_TRACKED_GUILDS }, (_, i) => ({
        name: `Guild${i}`,
        realm: 'Nightslayer'
      }))
    });

    expect(trackGuild(APEX)).toMatchObject({ added: false, reason: 'full' });
  });

  it('refuses an entry with no name', () => {
    fileMissing();
    expect(trackGuild({ realm: 'Nightslayer' })).toMatchObject({ added: false, reason: 'incomplete' });
  });
});

describe('untrackGuild', () => {
  it('removes by name and reports what went, so the caller can bin its history', () => {
    fileContains({ guilds: [APEX] });
    const result = untrackGuild({ name: 'apex' });

    expect(result.removed).toBe(true);
    expect(result.removedGuilds).toEqual([expect.objectContaining({ name: 'Apex' })]);
    expect(written().guilds).toEqual([]);
  });

  it('removes only the named realm when two guilds share a name', () => {
    fileContains({
      guilds: [APEX, { ...APEX, realm: 'Dreamscythe' }]
    });

    untrackGuild({ name: 'Apex', realm: 'Dreamscythe' });

    expect(written().guilds).toEqual([expect.objectContaining({ realm: 'Nightslayer' })]);
  });

  it('reports a miss rather than silently writing the file again', () => {
    fileContains({ guilds: [APEX] });

    expect(untrackGuild({ name: 'Nobody' })).toMatchObject({ removed: false, removedGuilds: [] });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('channelFor', () => {
  it('prefers the guild override', () => {
    expect(channelFor({ channelId: 'guild-channel' }, { channelId: 'default' })).toBe('guild-channel');
  });

  it('falls back to the default channel', () => {
    expect(channelFor({ channelId: null }, { channelId: 'default' })).toBe('default');
  });
});

describe('DAYS', () => {
  it('is Sunday-first, matching getUTCDay', () => {
    expect(DAYS[0]).toBe('Sunday');
    expect(DAYS[new Date(Date.UTC(2026, 8, 14)).getUTCDay()]).toBe('Monday');
  });
});
