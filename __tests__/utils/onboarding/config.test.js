jest.mock('fs');

const fs = require('fs');
const {
  DEFAULTS,
  MAX_GRACE_DAYS,
  MIN_GRACE_DAYS,
  clearConfigCache,
  disable,
  enable,
  loadConfig,
  normalizeConfig,
  saveConfig
} = require('../../../utils/onboarding/config');

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

function written() {
  const calls = fs.writeFileSync.mock.calls;
  return JSON.parse(calls[calls.length - 1][1]);
}

describe('normalizeConfig', () => {
  it('fills in every default', () => {
    expect(normalizeConfig({})).toEqual(DEFAULTS);
  });

  it('ships disabled, with no cutoff', () => {
    expect(normalizeConfig({})).toMatchObject({ enabled: false, enabledAt: null });
  });

  it('survives junk without throwing', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULTS);
    expect(normalizeConfig('nonsense')).toEqual(DEFAULTS);
  });

  it.each([
    ['a grace period below the floor', { graceDays: 0 }, MIN_GRACE_DAYS],
    ['a grace period of nonsense', { graceDays: 'soon' }, DEFAULTS.graceDays],
    ['a grace period above the ceiling', { graceDays: 9999 }, MAX_GRACE_DAYS]
  ])('clamps %s', (_label, input, expected) => {
    expect(normalizeConfig(input).graceDays).toBe(expected);
  });

  it('pulls the reminder back below the deadline', () => {
    // A reminder on or after the kick day is not a reminder.
    expect(normalizeConfig({ graceDays: 3, warnAfterDays: 9 }).warnAfterDays).toBe(2);
  });

  it('allows a same-day reminder when the grace period is one day', () => {
    expect(normalizeConfig({ graceDays: 1, warnAfterDays: 5 }).warnAfterDays).toBe(0);
  });

  it('keeps a reminder that already fits', () => {
    expect(normalizeConfig({ graceDays: 14, warnAfterDays: 10 }).warnAfterDays).toBe(10);
  });

  it('rejects a nonsensical cutoff rather than trusting it', () => {
    expect(normalizeConfig({ enabledAt: -1 }).enabledAt).toBeNull();
    expect(normalizeConfig({ enabledAt: 'yesterday' }).enabledAt).toBeNull();
  });
});

describe('loadConfig', () => {
  it('defaults to off on a first run', () => {
    fileMissing();

    expect(loadConfig().enabled).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('fails closed when the file is corrupt', () => {
    // Failing open here would mean removing members based on a broken file.
    fs.readFileSync.mockReturnValue('{ truncated');

    expect(loadConfig().enabled).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it('caches', () => {
    fileContains({ enabled: true });
    loadConfig();
    loadConfig();

    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('saveConfig', () => {
  it('writes atomically', () => {
    fileMissing();
    saveConfig({ graceDays: 10 });

    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('clamps on the way out', () => {
    fileMissing();
    saveConfig({ graceDays: 9999 });

    expect(written().graceDays).toBe(MAX_GRACE_DAYS);
  });

  it('moves the reminder when the grace period shrinks under it', () => {
    fileContains({ graceDays: 14, warnAfterDays: 10 });
    saveConfig({ graceDays: 5 });

    expect(written()).toMatchObject({ graceDays: 5, warnAfterDays: 4 });
  });
});

describe('enable', () => {
  it('stamps the cutoff, so existing members can never be removed', () => {
    fileMissing();
    const now = 1_800_000_000_000;

    enable(now);

    expect(written()).toMatchObject({ enabled: true, enabledAt: now });
  });

  it('re-stamps the cutoff on every switch-on', () => {
    // An amnesty for anyone who joined while it was off — the safe direction.
    fileContains({ enabled: false, enabledAt: 1000 });
    enable(2000);

    expect(written().enabledAt).toBe(2000);
  });
});

describe('disable', () => {
  it('turns the sweep off but leaves the settings alone', () => {
    fileContains({ enabled: true, enabledAt: 1000, graceDays: 10 });
    disable();

    expect(written()).toMatchObject({ enabled: false, enabledAt: 1000, graceDays: 10 });
  });
});
