jest.mock('fs');

const fs = require('fs');
const {
  DEFAULTS,
  VERBOSITY,
  clearConfigCache,
  loadConfig,
  normalizeConfig,
  saveConfig
} = require('../../../utils/audit/config');

beforeEach(() => {
  jest.clearAllMocks();
  clearConfigCache();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

function fileMissing() {
  const err = new Error('nope');
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

  it('ships off', () => {
    expect(normalizeConfig({}).enabled).toBe(false);
  });

  it('survives junk', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULTS);
    expect(normalizeConfig('nonsense')).toEqual(DEFAULTS);
  });

  it('falls back on an unknown verbosity rather than recording nothing by accident', () => {
    expect(normalizeConfig({ verbosity: 'chatty' }).verbosity).toBe(DEFAULTS.verbosity);
  });

  it.each(VERBOSITY)('accepts the %s level', level => {
    expect(normalizeConfig({ verbosity: level }).verbosity).toBe(level);
  });

  it('accepts a level in any casing', () => {
    expect(normalizeConfig({ verbosity: 'ALL' }).verbosity).toBe('all');
  });
});

describe('loadConfig', () => {
  it('defaults to off on a first run', () => {
    fileMissing();

    expect(loadConfig().enabled).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns but carries on when the file is corrupt', () => {
    fs.readFileSync.mockReturnValue('{ broken');

    expect(loadConfig()).toEqual(DEFAULTS);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('saveConfig', () => {
  it('writes atomically', () => {
    fileMissing();
    saveConfig({ enabled: true });

    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('merges rather than replacing', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ channelId: 'c1', verbosity: 'admin' }));
    saveConfig({ enabled: true });

    expect(written()).toMatchObject({ channelId: 'c1', verbosity: 'admin', enabled: true });
  });
});
