jest.mock('fs');

const fs = require('fs');
const {
  HISTORY_LOG_DIR,
  MAX_ENTRIES,
  appendReportHistoryEntry,
  deleteReportHistory,
  historyLogPath,
  loadReportHistory,
  saveReportHistory,
  summarizeForHistory
} = require('../../../utils/reports/reportHistory');

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

function diffWith(overrides = {}) {
  return {
    capturedAt: 1,
    isFirstRun: false,
    totals: { members: 10, atMaxLevel: 4 },
    joined: [],
    left: [],
    levelUps: [],
    promotions: [],
    demotions: [],
    kills: [],
    ...overrides
  };
}

describe('summarizeForHistory', () => {
  it('reduces a diff to counts, with no names', () => {
    const diff = diffWith({
      joined: [{ name: 'A' }],
      left: [{ name: 'B' }, { name: 'C' }],
      levelUps: [{ name: 'D' }],
      promotions: [{ name: 'E' }],
      demotions: [],
      kills: [{ change: 5 }, { change: 3 }]
    });

    expect(summarizeForHistory(diff)).toEqual({
      capturedAt: 1,
      isFirstRun: false,
      members: 10,
      atMaxLevel: 4,
      joined: 1,
      left: 2,
      levelUps: 1,
      promotions: 1,
      demotions: 0,
      killsGained: 8
    });
  });

  it('treats no kill gains as zero, not NaN', () => {
    expect(summarizeForHistory(diffWith()).killsGained).toBe(0);
  });
});

describe('loadReportHistory', () => {
  it('returns the stored entries', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ entries: [{ capturedAt: 1, members: 10 }] }));
    expect(loadReportHistory(KEY)).toEqual([{ capturedAt: 1, members: 10 }]);
  });

  it('is empty, and silent, the first time a guild is tracked', () => {
    fileMissing();

    expect(loadReportHistory(KEY)).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('degrades to empty rather than throwing when the file is corrupt', () => {
    fs.readFileSync.mockReturnValue('{ truncated');

    expect(loadReportHistory(KEY)).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it('rejects a payload whose entries are not an array', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ entries: 'nope' }));
    expect(loadReportHistory(KEY)).toEqual([]);
  });
});

describe('saveReportHistory', () => {
  it('writes atomically', () => {
    saveReportHistory(KEY, [{ capturedAt: 1, members: 10 }]);

    expect(fs.mkdirSync).toHaveBeenCalledWith(HISTORY_LOG_DIR, { recursive: true });
    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), historyLogPath(KEY));
  });
});

describe('appendReportHistoryEntry', () => {
  it('adds this report\'s entry to what was already there', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ entries: [{ capturedAt: 1, members: 8 }] }));

    appendReportHistoryEntry(KEY, diffWith({ capturedAt: 2, totals: { members: 9, atMaxLevel: 2 } }));

    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.entries.map(e => e.capturedAt)).toEqual([1, 2]);
    expect(written.entries[1].members).toBe(9);
  });

  it('keeps entries in chronological order even if appended out of order', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ entries: [{ capturedAt: 10, members: 1 }] }));

    appendReportHistoryEntry(KEY, diffWith({ capturedAt: 5 }));

    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.entries.map(e => e.capturedAt)).toEqual([5, 10]);
  });

  it('caps the history at MAX_ENTRIES, dropping the oldest', () => {
    const existing = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ capturedAt: i, members: 1 }));
    fs.readFileSync.mockReturnValue(JSON.stringify({ entries: existing }));

    appendReportHistoryEntry(KEY, diffWith({ capturedAt: MAX_ENTRIES }));

    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.entries).toHaveLength(MAX_ENTRIES);
    expect(written.entries[0].capturedAt).toBe(1); // the oldest (0) was dropped
    expect(written.entries.at(-1).capturedAt).toBe(MAX_ENTRIES);
  });

  it('starts clean when there is no history yet', () => {
    fileMissing();

    appendReportHistoryEntry(KEY, diffWith({ capturedAt: 1 }));

    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.entries).toHaveLength(1);
    expect(written.entries[0].capturedAt).toBe(1);
  });
});

describe('deleteReportHistory', () => {
  it('removes the file when a guild is untracked', () => {
    expect(deleteReportHistory(KEY)).toBe(true);
    expect(fs.unlinkSync).toHaveBeenCalledWith(historyLogPath(KEY));
  });

  it('is quiet when there was nothing to delete', () => {
    const err = new Error('gone');
    err.code = 'ENOENT';
    fs.unlinkSync.mockImplementation(() => {
      throw err;
    });

    expect(deleteReportHistory(KEY)).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns, but does not throw, on an unexpected delete failure', () => {
    fs.unlinkSync.mockImplementation(() => {
      throw new Error('disk on fire');
    });

    expect(deleteReportHistory(KEY)).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });
});
