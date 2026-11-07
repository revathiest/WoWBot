jest.mock('fs');

const fs = require('fs');
const {
  DEFAULTS,
  clearCache,
  load,
  normalizeStore,
  recordResults,
  save,
  stateOf
} = require('../../../utils/namespaceWatch/store');

beforeEach(() => {
  jest.clearAllMocks();
  clearCache();
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

function stored(contents) {
  fs.readFileSync.mockReturnValue(JSON.stringify(contents));
}

function written() {
  const calls = fs.writeFileSync.mock.calls;
  return JSON.parse(calls[calls.length - 1][1]);
}

describe('normalizeStore', () => {
  it('fills in the defaults', () => {
    expect(normalizeStore({})).toEqual(DEFAULTS);
  });

  it('survives junk', () => {
    expect(normalizeStore(null)).toEqual(DEFAULTS);
    expect(normalizeStore('nonsense')).toEqual(DEFAULTS);
  });

  it('starts with no last-checked stamp, so a first run is a baseline', () => {
    expect(normalizeStore({}).lastCheckedAt).toBeNull();
  });

  it('drops an endpoint whose state cannot be read rather than guessing', () => {
    const result = normalizeStore({
      endpoints: {
        good: { state: 'available', since: 5, status: 200 },
        bad: { state: 'chatty', since: 5 }
      }
    });

    expect(Object.keys(result.endpoints)).toEqual(['good']);
  });

  it('rejects a nonsense timestamp', () => {
    expect(normalizeStore({ lastCheckedAt: 'soon' }).lastCheckedAt).toBeNull();
    expect(normalizeStore({ lastCheckedAt: -5 }).lastCheckedAt).toBeNull();
  });

  it('keeps the patch string as a string', () => {
    expect(normalizeStore({ patch: 1.6 }).patch).toBe('1.6');
    expect(normalizeStore({ patch: null }).patch).toBeNull();
  });
});

describe('load', () => {
  it('returns defaults when the file does not exist yet', () => {
    fileMissing();
    expect(load()).toEqual(DEFAULTS);
  });

  it('does not warn about a missing file — that is the normal first run', () => {
    fileMissing();
    load();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns about an unreadable file but still starts', () => {
    fs.readFileSync.mockImplementation(() => {
      throw new Error('truncated');
    });

    expect(load()).toEqual(DEFAULTS);
    expect(console.warn).toHaveBeenCalled();
  });

  it('caches, so a poll does not re-read the file per check', () => {
    stored({ lastCheckedAt: 10, endpoints: {} });

    load();
    load();

    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('save', () => {
  it('writes atomically via a temp file and a rename', () => {
    fileMissing();
    save({ lastCheckedAt: 10 });

    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('creates the data directory', () => {
    fileMissing();
    save({});
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });
});

describe('recordResults', () => {
  it('stamps the time it ran, which is what ends the baseline', () => {
    fileMissing();
    const next = recordResults([{ key: 'a', state: 'pending', status: 404 }], { now: 1000 });

    expect(next.lastCheckedAt).toBe(1000);
  });

  it('keeps `since` while a state is unchanged', () => {
    stored({ lastCheckedAt: 500, endpoints: { a: { state: 'pending', since: 100, status: 404 } } });

    const next = recordResults([{ key: 'a', state: 'pending', status: 404 }], { now: 900 });

    expect(next.endpoints.a.since).toBe(100);
  });

  it('resets `since` when the state moves', () => {
    stored({ lastCheckedAt: 500, endpoints: { a: { state: 'pending', since: 100, status: 404 } } });

    const next = recordResults([{ key: 'a', state: 'available', status: 200 }], { now: 900 });

    expect(next.endpoints.a.since).toBe(900);
  });

  it('leaves endpoints it was not told about alone', () => {
    stored({ lastCheckedAt: 500, endpoints: { a: { state: 'available', since: 1, status: 200 } } });

    const next = recordResults([{ key: 'b', state: 'pending', status: 404 }], { now: 900 });

    expect(next.endpoints.a.state).toBe('available');
    expect(next.endpoints.b.state).toBe('pending');
  });

  it('keeps the previous patch when this poll could not read one', () => {
    stored({ lastCheckedAt: 500, patch: '1.60.1', endpoints: {} });

    const next = recordResults([], { now: 900, patch: null });

    expect(next.patch).toBe('1.60.1');
  });

  it('records a new patch string', () => {
    stored({ lastCheckedAt: 500, patch: '1.60.1', endpoints: {} });

    expect(recordResults([], { now: 900, patch: '1.61.0' }).patch).toBe('1.61.0');
  });

  it('persists what it recorded', () => {
    fileMissing();
    recordResults([{ key: 'a', state: 'available', status: 200 }], { now: 1000 });

    expect(written().endpoints.a.state).toBe('available');
  });
});

describe('stateOf', () => {
  it('returns null for an endpoint never polled', () => {
    fileMissing();
    expect(stateOf('nope')).toBeNull();
  });

  it('returns the recorded state', () => {
    stored({ lastCheckedAt: 1, endpoints: { a: { state: 'available', since: 1, status: 200 } } });
    expect(stateOf('a')).toBe('available');
  });
});
