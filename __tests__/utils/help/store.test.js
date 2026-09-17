jest.mock('fs');

const fs = require('fs');
const store = require('../../../utils/help/store');

beforeEach(() => {
  jest.clearAllMocks();
  store.clearCache();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

function fileContains(value) {
  fs.readFileSync.mockReturnValue(typeof value === 'string' ? value : JSON.stringify(value));
}

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

describe('normalizeStore', () => {
  it('keeps a usable entry', () => {
    expect(store.normalizeStore({ g1: { channelId: 'c1', messageIds: ['m1'], fingerprint: 'abc' } })).toEqual({
      g1: { channelId: 'c1', messageIds: ['m1'], fingerprint: 'abc' }
    });
  });

  it('defaults the fingerprint, so an old file republishes rather than no-ops', () => {
    expect(store.normalizeStore({ g1: { channelId: 'c1' } }).g1.fingerprint).toBeNull();
  });

  it('drops an entry with no channel, which cannot point anywhere', () => {
    expect(store.normalizeStore({ g1: { messageIds: ['m1'] } })).toEqual({});
  });

  it('defaults the message list when it is absent or junk', () => {
    expect(store.normalizeStore({ g1: { channelId: 'c1' } }).g1.messageIds).toEqual([]);
    expect(store.normalizeStore({ g1: { channelId: 'c1', messageIds: 'nope' } }).g1.messageIds).toEqual([]);
  });

  it('strips blank ids from the list', () => {
    const result = store.normalizeStore({ g1: { channelId: 'c1', messageIds: ['m1', '', null] } });
    expect(result.g1.messageIds).toEqual(['m1']);
  });

  it('survives junk', () => {
    expect(store.normalizeStore(null)).toEqual({});
    expect(store.normalizeStore('nonsense')).toEqual({});
  });
});

describe('load', () => {
  it('is empty on a first run, quietly', () => {
    fileMissing();

    expect(store.load()).toEqual({});
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns but carries on when the file is corrupt', () => {
    fileContains('{ broken');

    expect(store.load()).toEqual({});
    expect(console.warn).toHaveBeenCalled();
  });

  it('caches', () => {
    fileContains({});
    store.load();
    store.load();

    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('get and set', () => {
  it('returns null for a guild with no help post', () => {
    fileMissing();
    expect(store.get('g1')).toBeNull();
  });

  it('writes atomically', () => {
    fileMissing();
    store.set('g1', { channelId: 'c1' });

    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('merges rather than replacing', () => {
    fileContains({ g1: { channelId: 'c1', messageIds: ['m1'] } });
    store.set('g1', { messageIds: ['m2', 'm3'] });

    expect(store.get('g1')).toMatchObject({ channelId: 'c1', messageIds: ['m2', 'm3'] });
  });

  it('keeps other guilds untouched', () => {
    fileContains({ g1: { channelId: 'c1', messageIds: [] }, g2: { channelId: 'c2', messageIds: [] } });
    store.set('g1', { messageIds: ['m1'] });

    expect(written().g2).toMatchObject({ channelId: 'c2', messageIds: [] });
  });
});

describe('clear', () => {
  it('removes a guild', () => {
    fileContains({ g1: { channelId: 'c1', messageIds: [] } });

    expect(store.clear('g1')).toBe(true);
    expect(written()).toEqual({});
  });

  it('reports a miss without writing', () => {
    fileContains({});

    expect(store.clear('g1')).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('guildIds', () => {
  it('lists the guilds with a help post', () => {
    fileContains({ g1: { channelId: 'c1', messageIds: [] }, g2: { channelId: 'c2', messageIds: [] } });
    expect(store.guildIds().sort()).toEqual(['g1', 'g2']);
  });

  it('is empty when nothing is set up', () => {
    fileMissing();
    expect(store.guildIds()).toEqual([]);
  });
});
