jest.mock('fs');

const fs = require('fs');
const {
  clearStateCache,
  loadWarned,
  normalizeState,
  recordSweep,
  wasWarned
} = require('../../../utils/onboarding/state');

beforeEach(() => {
  jest.clearAllMocks();
  clearStateCache();
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

describe('normalizeState', () => {
  it('keeps usable pairs', () => {
    expect(normalizeState({ u1: 1000 })).toEqual({ u1: 1000 });
  });

  it('drops entries with no timestamp', () => {
    expect(normalizeState({ u1: null, u2: 'yesterday', u3: 0 })).toEqual({});
  });

  it('survives junk', () => {
    expect(normalizeState(null)).toEqual({});
    expect(normalizeState('nonsense')).toEqual({});
  });
});

describe('loadWarned', () => {
  it('is empty on a first run', () => {
    fileMissing();

    expect(loadWarned()).toEqual({});
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('falls back to empty when the file is corrupt', () => {
    // Worst case: somebody gets a second reminder. The alternative — assuming
    // everyone was warned — would send people straight to a kick.
    fs.readFileSync.mockReturnValue('{ broken');

    expect(loadWarned()).toEqual({});
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('wasWarned', () => {
  it('recognises somebody already reminded', () => {
    fileContains({ u1: 1000 });
    expect(wasWarned('u1')).toBe(true);
  });

  it('is false for anyone else', () => {
    fileContains({ u1: 1000 });
    expect(wasWarned('u2')).toBe(false);
  });
});

describe('recordSweep', () => {
  it('records who was reminded', () => {
    fileMissing();
    recordSweep({ warnedIds: ['u1'], keepIds: [], now: 5000 });

    expect(written()).toEqual({ u1: 5000 });
  });

  it('forgets members who are no longer being tracked', () => {
    // Someone who picked a role, left, or was kicked must not linger forever.
    fileContains({ gone: 1000, stillwaiting: 1000 });
    recordSweep({ warnedIds: [], keepIds: ['stillwaiting'], now: 5000 });

    expect(written()).toEqual({ stillwaiting: 1000 });
  });

  it('keeps the original warning time rather than refreshing it', () => {
    fileContains({ u1: 1000 });
    recordSweep({ warnedIds: [], keepIds: ['u1'], now: 5000 });

    expect(loadWarned()).toEqual({ u1: 1000 });
  });

  it('does not write when nothing changed', () => {
    // The sweep runs every ten minutes forever; an unconditional write would be
    // a pointless disk write each time.
    fileContains({ u1: 1000 });
    recordSweep({ warnedIds: [], keepIds: ['u1'], now: 5000 });

    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('writes atomically when it does write', () => {
    fileMissing();
    recordSweep({ warnedIds: ['u1'], keepIds: [], now: 5000 });

    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('prunes and records in one write', () => {
    fileContains({ gone: 1000 });
    recordSweep({ warnedIds: ['fresh'], keepIds: [], now: 5000 });

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(written()).toEqual({ fresh: 5000 });
  });
});
