jest.mock('fs');

const fs = require('fs');
const path = require('path');
const {
  SNAPSHOT_DIR,
  deleteSnapshot,
  loadSnapshot,
  saveSnapshot,
  snapshotFileName,
  snapshotPath
} = require('../../../utils/reports/history');

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

function fileMissing() {
  const err = new Error('no such file');
  err.code = 'ENOENT';
  fs.readFileSync.mockImplementation(() => {
    throw err;
  });
}

const KEY = 'us:anniversary:nightslayer:apex';

describe('snapshotFileName', () => {
  it('turns a guild key into one flat file name', () => {
    expect(snapshotFileName(KEY)).toBe('us-anniversary-nightslayer-apex.json');
  });

  it('refuses to let a key escape the snapshot directory', () => {
    const escaped = snapshotPath('../../.env');
    expect(path.dirname(escaped)).toBe(SNAPSHOT_DIR);
    expect(snapshotFileName('../../.env')).not.toContain('..');
  });

  it('replaces path separators rather than creating directories', () => {
    expect(snapshotFileName('a/b\\c')).toBe('a_b_c.json');
  });
});

describe('loadSnapshot', () => {
  it('returns the stored snapshot', () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ capturedAt: 5, members: {} }));
    expect(loadSnapshot(KEY)).toEqual({ capturedAt: 5, members: {} });
  });

  it('is null, and silent, the first time a guild is reported on', () => {
    fileMissing();

    expect(loadSnapshot(KEY)).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('degrades to a first run rather than throwing when the file is corrupt', () => {
    fs.readFileSync.mockReturnValue('{ truncated');

    expect(loadSnapshot(KEY)).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('rejects a file that parses to something that is not an object', () => {
    fs.readFileSync.mockReturnValue('42');
    expect(loadSnapshot(KEY)).toBeNull();
  });
});

describe('saveSnapshot', () => {
  it('writes atomically, so an interrupted write cannot corrupt history', () => {
    saveSnapshot(KEY, { capturedAt: 1 });

    expect(fs.mkdirSync).toHaveBeenCalledWith(SNAPSHOT_DIR, { recursive: true });
    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp$/),
      snapshotPath(KEY)
    );
  });

  it('round-trips a snapshot', () => {
    const snapshot = { capturedAt: 7, members: { butud: { name: 'Butud' } } };
    saveSnapshot(KEY, snapshot);

    expect(JSON.parse(fs.writeFileSync.mock.calls[0][1])).toEqual(snapshot);
  });
});

describe('deleteSnapshot', () => {
  it('removes the file when a guild is untracked', () => {
    expect(deleteSnapshot(KEY)).toBe(true);
    expect(fs.unlinkSync).toHaveBeenCalledWith(snapshotPath(KEY));
  });

  it('is quiet when there was nothing to delete', () => {
    const err = new Error('gone');
    err.code = 'ENOENT';
    fs.unlinkSync.mockImplementation(() => {
      throw err;
    });

    expect(deleteSnapshot(KEY)).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns on a real delete failure', () => {
    fs.unlinkSync.mockImplementation(() => {
      throw new Error('permission denied');
    });

    expect(deleteSnapshot(KEY)).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });
});
