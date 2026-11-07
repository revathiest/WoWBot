jest.mock('fs');

const fs = require('fs');
const {
  KILL_HISTORY_DIR,
  MAX_ENTRIES,
  appendKillEntry,
  deleteKillHistory,
  entryAtOrBefore,
  killHistoryPath,
  loadKillHistory,
  saveKillHistory
} = require('../../../utils/reports/killHistory');

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const KEY = 'us:anniversary:nightslayer:apex';

function fileMissing() {
  const err = new Error('no such file');
  err.code = 'ENOENT';
  fs.readFileSync.mockImplementation(() => {
    throw err;
  });
}

describe('loadKillHistory', () => {
  it('returns the stored entries', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ entries: [{ capturedAt: 1, kills: {} }] }));
    expect(loadKillHistory(KEY)).toEqual([{ capturedAt: 1, kills: {} }]);
  });

  it('is empty, and silent, the first time a guild is tracked', () => {
    fileMissing();

    expect(loadKillHistory(KEY)).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('degrades to empty rather than throwing when the file is corrupt', () => {
    fs.readFileSync.mockReturnValue('{ truncated');

    expect(loadKillHistory(KEY)).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it('rejects a payload whose entries are not an array', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ entries: 'nope' }));
    expect(loadKillHistory(KEY)).toEqual([]);
  });
});

describe('saveKillHistory', () => {
  it('writes atomically', () => {
    saveKillHistory(KEY, [{ capturedAt: 1, kills: {} }]);

    expect(fs.mkdirSync).toHaveBeenCalledWith(KILL_HISTORY_DIR, { recursive: true });
    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), killHistoryPath(KEY));
  });
});

describe('appendKillEntry', () => {
  it('adds today\'s entry to what was already there', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ entries: [{ capturedAt: 1, kills: { a: 1 } }] }));

    appendKillEntry(KEY, { capturedAt: 2, kills: { a: 5 } });

    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.entries).toEqual([
      { capturedAt: 1, kills: { a: 1 } },
      { capturedAt: 2, kills: { a: 5 } }
    ]);
  });

  it('keeps entries in chronological order even if appended out of order', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ entries: [{ capturedAt: 10, kills: {} }] }));

    appendKillEntry(KEY, { capturedAt: 5, kills: {} });

    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.entries.map(e => e.capturedAt)).toEqual([5, 10]);
  });

  it('caps the history at MAX_ENTRIES, dropping the oldest', () => {
    const existing = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ capturedAt: i, kills: {} }));
    fs.readFileSync.mockReturnValue(JSON.stringify({ entries: existing }));

    appendKillEntry(KEY, { capturedAt: MAX_ENTRIES, kills: {} });

    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.entries).toHaveLength(MAX_ENTRIES);
    expect(written.entries[0].capturedAt).toBe(1); // the oldest (0) was dropped
    expect(written.entries.at(-1).capturedAt).toBe(MAX_ENTRIES);
  });

  it('starts clean when there is no history yet', () => {
    fileMissing();

    appendKillEntry(KEY, { capturedAt: 1, kills: { a: 1 } });

    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.entries).toEqual([{ capturedAt: 1, kills: { a: 1 } }]);
  });
});

describe('deleteKillHistory', () => {
  it('removes the file when a guild is untracked', () => {
    expect(deleteKillHistory(KEY)).toBe(true);
    expect(fs.unlinkSync).toHaveBeenCalledWith(killHistoryPath(KEY));
  });

  it('is quiet when there was nothing to delete', () => {
    const err = new Error('gone');
    err.code = 'ENOENT';
    fs.unlinkSync.mockImplementation(() => {
      throw err;
    });

    expect(deleteKillHistory(KEY)).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe('entryAtOrBefore', () => {
  const entries = [{ capturedAt: 10 }, { capturedAt: 20 }, { capturedAt: 30 }];

  it('finds the most recent entry at or before the timestamp', () => {
    expect(entryAtOrBefore(entries, 25)).toEqual({ capturedAt: 20 });
  });

  it('matches an exact timestamp', () => {
    expect(entryAtOrBefore(entries, 20)).toEqual({ capturedAt: 20 });
  });

  it('is null when every entry is after the timestamp', () => {
    expect(entryAtOrBefore(entries, 5)).toBeNull();
  });
});
