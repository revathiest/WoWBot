jest.mock('fs');

const fs = require('fs');
const {
  DEFAULTS,
  clearConfigCache,
  loadConfig,
  normalizeConfig,
  saveConfig
} = require('../../../utils/nicknames/config');

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

describe('normalizeConfig', () => {
  it('fills in the defaults', () => {
    expect(normalizeConfig({})).toEqual(DEFAULTS);
  });

  it('ships off, so nobody is renamed unexpectedly', () => {
    expect(normalizeConfig({}).enabled).toBe(false);
  });

  it('survives junk', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULTS);
    expect(normalizeConfig('nonsense')).toEqual(DEFAULTS);
  });

  it('rejects a nonsensical timestamp', () => {
    expect(normalizeConfig({ lastSyncAt: -1 }).lastSyncAt).toBeNull();
  });
});

describe('loadConfig', () => {
  it('is off on a first run, quietly', () => {
    fileMissing();

    expect(loadConfig().enabled).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('fails to off when the file is corrupt', () => {
    // Failing open here would start renaming people based on a broken file.
    fs.readFileSync.mockReturnValue('{ truncated');

    expect(loadConfig().enabled).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it('caches', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ enabled: true }));
    loadConfig();
    loadConfig();

    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
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
    fs.readFileSync.mockReturnValue(JSON.stringify({ lastSyncAt: 1000 }));
    saveConfig({ enabled: true });

    const written = JSON.parse(fs.writeFileSync.mock.calls.at(-1)[1]);
    expect(written).toMatchObject({ enabled: true, lastSyncAt: 1000 });
  });
});
