jest.mock('fs');

const fs = require('fs');
const {
  addRole,
  clearConfigCache,
  getRoleIds,
  loadConfig,
  normalizeConfig,
  removeRole,
  saveConfig
} = require('../../../utils/adminRoles/config');

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

describe('normalizeConfig', () => {
  it('returns an empty map for an empty object', () => {
    expect(normalizeConfig({})).toEqual({});
  });

  it('survives junk input without throwing', () => {
    expect(normalizeConfig(null)).toEqual({});
    expect(normalizeConfig('nonsense')).toEqual({});
    expect(normalizeConfig(undefined)).toEqual({});
  });

  it('drops a guild whose role list is empty', () => {
    expect(normalizeConfig({ 'guild-1': [] })).toEqual({});
  });

  it('dedupes and stringifies role ids, dropping nullish entries', () => {
    expect(normalizeConfig({ 'guild-1': ['r1', 'r1', null, undefined, 'r2'] })).toEqual({
      'guild-1': ['r1', 'r2']
    });
  });

  it('drops a guild key with no id', () => {
    expect(normalizeConfig({ '  ': ['r1'] })).toEqual({});
  });
});

describe('loadConfig', () => {
  it('starts empty when the file does not exist', () => {
    fileMissing();
    expect(loadConfig()).toEqual({});
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('falls back to empty on a corrupt file, with a warning', () => {
    fileContains('not json');
    expect(loadConfig()).toEqual({});
    expect(console.warn).toHaveBeenCalled();
  });

  it('caches the result across calls', () => {
    fileContains({ 'guild-1': ['r1'] });
    loadConfig();
    loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('saveConfig', () => {
  it('writes atomically via a temp file and rename', () => {
    fileMissing();
    saveConfig({ 'guild-1': ['r1'] });

    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      expect.any(String),
      'utf8'
    );
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('merges onto the existing config rather than replacing it wholesale', () => {
    fileContains({ 'guild-1': ['r1'] });
    const next = saveConfig({ 'guild-2': ['r2'] });

    expect(next).toEqual({ 'guild-1': ['r1'], 'guild-2': ['r2'] });
  });
});

describe('getRoleIds / addRole / removeRole', () => {
  beforeEach(() => fileMissing());

  it('returns an empty list for an unconfigured guild', () => {
    expect(getRoleIds('guild-1')).toEqual([]);
  });

  it('returns an empty list for a missing guild id', () => {
    expect(getRoleIds(null)).toEqual([]);
    expect(getRoleIds(undefined)).toEqual([]);
  });

  it('adds a role to a guild without disturbing another guild', () => {
    addRole('guild-1', 'r1');
    addRole('guild-2', 'r9');

    expect(getRoleIds('guild-1')).toEqual(['r1']);
    expect(getRoleIds('guild-2')).toEqual(['r9']);
  });

  it('does not duplicate a role already on the list', () => {
    addRole('guild-1', 'r1');
    addRole('guild-1', 'r1');

    expect(getRoleIds('guild-1')).toEqual(['r1']);
  });

  it('removes a role, leaving the rest', () => {
    addRole('guild-1', 'r1');
    addRole('guild-1', 'r2');
    removeRole('guild-1', 'r1');

    expect(getRoleIds('guild-1')).toEqual(['r2']);
  });

  it('removing an absent role is a no-op', () => {
    addRole('guild-1', 'r1');
    removeRole('guild-1', 'does-not-exist');

    expect(getRoleIds('guild-1')).toEqual(['r1']);
  });
});
