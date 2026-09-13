jest.mock('fs');

const fs = require('fs');
const {
  CONFIG_PATH,
  DEFAULTS,
  MAX_TIMEOUT_MS,
  clearConfigCache,
  loadConfig,
  normalizeConfig,
  saveConfig
} = require('../../../utils/spam/config');

beforeEach(() => {
  jest.clearAllMocks();
  clearConfigCache();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

/** Makes readFileSync behave like a file containing `value`. */
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

describe('normalizeConfig', () => {
  it('fills in every default for an empty object', () => {
    expect(normalizeConfig({})).toEqual(DEFAULTS);
  });

  it('ships disabled', () => {
    expect(normalizeConfig({}).enabled).toBe(false);
  });

  it('survives junk input without throwing', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULTS);
    expect(normalizeConfig('nonsense')).toEqual(DEFAULTS);
    expect(normalizeConfig(undefined)).toEqual(DEFAULTS);
  });

  it.each([
    ['rate count below the floor', { rateLimit: { count: 1 } }, c => c.rateLimit.count, 2],
    ['rate count above the ceiling', { rateLimit: { count: 9999 } }, c => c.rateLimit.count, 50],
    ['window below the floor', { rateLimit: { windowMs: 5 } }, c => c.rateLimit.windowMs, 1000],
    ['signal threshold above the ceiling', { signalThreshold: 50 }, c => c.signalThreshold, 10],
    ['new-account days above the ceiling', { newAccountDays: 5000 }, c => c.newAccountDays, 365],
    ['timeout above Discord max', { timeoutMs: 99e9 }, c => c.timeoutMs, MAX_TIMEOUT_MS]
  ])('clamps %s', (_label, input, read, expected) => {
    expect(read(normalizeConfig(input))).toBe(expected);
  });

  it('falls back when a numeric field is not a number', () => {
    expect(normalizeConfig({ signalThreshold: 'lots' }).signalThreshold).toBe(
      DEFAULTS.signalThreshold
    );
  });

  it('rejects an unknown action', () => {
    expect(normalizeConfig({ action: 'vaporize' }).action).toBe('ban');
    expect(normalizeConfig({ action: 'TIMEOUT' }).action).toBe('timeout');
  });

  it('de-duplicates and trims id lists, dropping empties', () => {
    expect(normalizeConfig({ exemptRoleIds: [' 1 ', '1', '', null, '2'] }).exemptRoleIds).toEqual([
      '1',
      '2'
    ]);
  });

  it('ignores unknown keys', () => {
    expect(normalizeConfig({ somethingElse: true })).toEqual(DEFAULTS);
  });
});

describe('loadConfig', () => {
  it('returns defaults when the file does not exist', () => {
    fileMissing();

    expect(loadConfig()).toEqual(DEFAULTS);
    // A missing file is the normal first run, so it must not warn.
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('reads and normalizes a stored file', () => {
    fileContains({ enabled: true, action: 'timeout', signalThreshold: 3 });

    const config = loadConfig();

    expect(config.enabled).toBe(true);
    expect(config.action).toBe('timeout');
    expect(config.signalThreshold).toBe(3);
  });

  it('falls back to defaults on corrupt JSON, and says so', () => {
    fileContains('{ not json');

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
  beforeEach(() => fileMissing());

  it('merges changes over the current config', () => {
    const saved = saveConfig({ enabled: true });

    expect(saved.enabled).toBe(true);
    expect(saved.signalThreshold).toBe(DEFAULTS.signalThreshold);
  });

  it('writes atomically — temp file then rename', () => {
    saveConfig({ enabled: true });

    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      `${CONFIG_PATH}.tmp`,
      expect.stringContaining('"enabled": true'),
      'utf8'
    );
    expect(fs.renameSync).toHaveBeenCalledWith(`${CONFIG_PATH}.tmp`, CONFIG_PATH);
  });

  it('clamps values on the way in, so a bad command cannot corrupt the file', () => {
    expect(saveConfig({ signalThreshold: 999 }).signalThreshold).toBe(10);
  });

  it('updates the cache without re-reading the file', () => {
    saveConfig({ enabled: true });
    fs.readFileSync.mockClear();

    expect(loadConfig().enabled).toBe(true);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });
});
