jest.mock('fs');

const fs = require('fs');
const store = require('../../../utils/voice/store');

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
  const err = new Error('no such file');
  err.code = 'ENOENT';
  fs.readFileSync.mockImplementation(() => {
    throw err;
  });
}

describe('normalizeStore', () => {
  it('starts empty', () => {
    expect(store.normalizeStore({})).toEqual({ settings: {}, active: {} });
  });

  it('survives junk', () => {
    expect(store.normalizeStore(null)).toEqual({ settings: {}, active: {} });
    expect(store.normalizeStore('nonsense')).toEqual({ settings: {}, active: {} });
  });

  it('drops settings with no trigger channel, which are not a setup', () => {
    expect(store.normalizeStore({ settings: { g1: { categoryId: 'cat1' } } }).settings).toEqual({});
  });

  it('keeps a configured category alongside the trigger channel', () => {
    const settings = store.normalizeStore({
      settings: { g1: { triggerChannelId: 't1', categoryId: 'cat1' } }
    }).settings;

    expect(settings.g1).toEqual({ triggerChannelId: 't1', categoryId: 'cat1' });
  });

  it('drops active rooms with no owner or guild', () => {
    expect(store.normalizeStore({ active: { c1: { guildId: 'g1' } } }).active).toEqual({});
    expect(store.normalizeStore({ active: { c1: { ownerId: 'u1' } } }).active).toEqual({});
  });

  it('defaults a missing createdAt to now', () => {
    const before = Date.now();
    const active = store.normalizeStore({ active: { c1: { guildId: 'g1', ownerId: 'u1' } } }).active;

    expect(active.c1.createdAt).toBeGreaterThanOrEqual(before);
  });
});

describe('load', () => {
  it('starts empty on a first run, quietly', () => {
    fileMissing();

    expect(store.load()).toEqual({ settings: {}, active: {} });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns but carries on when the file is corrupt', () => {
    fs.readFileSync.mockReturnValue('{ truncated');

    expect(store.load().active).toEqual({});
    expect(console.warn).toHaveBeenCalled();
  });

  it('caches', () => {
    fileContains({});
    store.load();
    store.load();

    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('settings', () => {
  it('saves and reads back a trigger channel', () => {
    fileMissing();
    store.setSettings('g1', { triggerChannelId: 't1' });

    expect(store.getSettings('g1')).toMatchObject({ triggerChannelId: 't1' });
  });

  it('merges rather than replacing', () => {
    fileContains({ settings: { g1: { triggerChannelId: 't1', categoryId: 'cat1' } } });
    store.setSettings('g1', { triggerChannelId: 't2' });

    expect(store.getSettings('g1')).toMatchObject({ triggerChannelId: 't2', categoryId: 'cat1' });
  });

  it('is null for a guild that has never set one up', () => {
    fileMissing();
    expect(store.getSettings('nope')).toBeNull();
  });

  it('writes atomically', () => {
    fileMissing();
    store.setSettings('g1', { triggerChannelId: 't1' });

    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('clears a guild\'s setup entirely', () => {
    fileContains({ settings: { g1: { triggerChannelId: 't1' } } });
    store.clearSettings('g1');

    expect(store.getSettings('g1')).toBeNull();
  });
});

describe('active rooms', () => {
  it('records a new room against its channel id', () => {
    fileMissing();
    store.addActiveChannel('c1', { guildId: 'g1', ownerId: 'u1' });

    expect(store.getActiveChannel('c1')).toMatchObject({ guildId: 'g1', ownerId: 'u1' });
  });

  it('is null for a channel that is not one of ours', () => {
    fileMissing();
    expect(store.getActiveChannel('nope')).toBeNull();
  });

  it('removes a room once it closes', () => {
    fileContains({ active: { c1: { guildId: 'g1', ownerId: 'u1', createdAt: 1 } } });

    expect(store.removeActiveChannel('c1')).toBe(true);
    expect(store.getActiveChannel('c1')).toBeNull();
  });

  it('reports removing a room that was not tracked', () => {
    fileMissing();
    expect(store.removeActiveChannel('nope')).toBe(false);
  });

  it('lists only one guild\'s rooms', () => {
    fileContains({
      active: {
        c1: { guildId: 'g1', ownerId: 'u1', createdAt: 1 },
        c2: { guildId: 'g2', ownerId: 'u2', createdAt: 2 }
      }
    });

    const rooms = store.activeChannelsForGuild('g1');
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ channelId: 'c1', ownerId: 'u1' });
  });
});
