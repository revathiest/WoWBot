jest.mock('fs');

const fs = require('fs');
const store = require('../../../utils/tickets/store');

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

function written() {
  const calls = fs.writeFileSync.mock.calls;
  return JSON.parse(calls[calls.length - 1][1]);
}

const TICKET = {
  id: 1,
  guildId: 'g1',
  userId: 'u1',
  channelId: 'c1',
  description: 'Help me',
  createdAt: 1000
};

describe('normalizeStore', () => {
  it('starts empty', () => {
    expect(store.normalizeStore({})).toEqual({
      settings: {},
      roles: {},
      open: {},
      closed: [],
      nextId: 1
    });
  });

  it('survives junk', () => {
    expect(store.normalizeStore(null).nextId).toBe(1);
    expect(store.normalizeStore('nonsense').open).toEqual({});
  });

  it('drops settings with no channel, which are not a lobby', () => {
    expect(store.normalizeStore({ settings: { g1: { messageId: 'm1' } } }).settings).toEqual({});
  });

  it('defaults lobby policing on, matching the system this came from', () => {
    const settings = store.normalizeStore({ settings: { g1: { channelId: 'c1' } } }).settings;
    expect(settings.g1.policeLobby).toBe(true);
  });

  it('keeps lobby policing off once switched off', () => {
    const settings = store.normalizeStore({
      settings: { g1: { channelId: 'c1', policeLobby: false } }
    }).settings;

    expect(settings.g1.policeLobby).toBe(false);
  });

  it('never reissues an id already used by an open ticket', () => {
    // A recycled id would wire a new ticket's buttons to an old ticket.
    const result = store.normalizeStore({ nextId: 1, open: { c1: { ...TICKET, id: 42 } } });
    expect(result.nextId).toBe(43);
  });

  it('never reissues an id already used by a closed ticket', () => {
    const result = store.normalizeStore({ nextId: 1, closed: [{ ...TICKET, id: 99 }] });
    expect(result.nextId).toBe(100);
  });

  it('caps closed history, keeping the most recent', () => {
    const closed = Array.from({ length: store.MAX_CLOSED_HISTORY + 50 }, (_, i) => ({
      ...TICKET,
      id: i + 1
    }));

    const result = store.normalizeStore({ closed });

    expect(result.closed).toHaveLength(store.MAX_CLOSED_HISTORY);
    expect(result.closed.at(-1).id).toBe(store.MAX_CLOSED_HISTORY + 50);
  });

  it('drops tickets with no usable id', () => {
    expect(store.normalizeStore({ open: { c1: { guildId: 'g1' } } }).open).toEqual({});
  });
});

describe('load', () => {
  it('starts empty on a first run, quietly', () => {
    fileMissing();

    expect(store.load().nextId).toBe(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns but carries on when the file is corrupt', () => {
    fs.readFileSync.mockReturnValue('{ truncated');

    expect(store.load().open).toEqual({});
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
  it('saves and reads back a lobby', () => {
    fileMissing();
    store.setSettings('g1', { channelId: 'c1', messageId: 'm1' });

    expect(store.getSettings('g1')).toMatchObject({ channelId: 'c1', messageId: 'm1' });
  });

  it('merges rather than replacing', () => {
    fileContains({ settings: { g1: { channelId: 'c1', archiveCategoryId: 'a1' } } });
    store.setSettings('g1', { messageId: 'm2' });

    expect(store.getSettings('g1')).toMatchObject({
      channelId: 'c1',
      archiveCategoryId: 'a1',
      messageId: 'm2'
    });
  });

  it('is null for a guild that has never set one up', () => {
    fileMissing();
    expect(store.getSettings('nope')).toBeNull();
  });

  it('writes atomically', () => {
    fileMissing();
    store.setSettings('g1', { channelId: 'c1' });

    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalled();
  });
});

describe('roles', () => {
  it('adds a role', () => {
    fileMissing();

    expect(store.addRole('g1', 'r1').added).toBe(true);
    expect(store.getRoles('g1')).toEqual(['r1']);
  });

  it('refuses a duplicate without writing again', () => {
    fileContains({ roles: { g1: ['r1'] } });

    expect(store.addRole('g1', 'r1').added).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('removes a role', () => {
    fileContains({ roles: { g1: ['r1', 'r2'] } });

    expect(store.removeRole('g1', 'r1').removed).toBe(true);
    expect(store.getRoles('g1')).toEqual(['r2']);
  });

  it('reports removing a role that was not there', () => {
    fileContains({ roles: { g1: ['r1'] } });
    expect(store.removeRole('g1', 'nope').removed).toBe(false);
  });

  it('is an empty list for an unconfigured guild', () => {
    fileMissing();
    expect(store.getRoles('g1')).toEqual([]);
  });
});

describe('tickets', () => {
  it('reserves ids without creating anything', () => {
    fileMissing();

    expect(store.reserveId()).toBe(1);
    expect(store.reserveId()).toBe(2);
    expect(store.load().open).toEqual({});
  });

  it('records an open ticket against its channel', () => {
    fileMissing();
    store.openTicket(TICKET);

    expect(store.getOpenByChannel('c1')).toMatchObject({ id: 1, userId: 'u1' });
  });

  it('refuses a ticket with no channel, since it could never be found again', () => {
    fileMissing();
    expect(store.openTicket({ ...TICKET, channelId: null })).toBeNull();
  });

  it('finds an open ticket by id, which is what buttons carry', () => {
    fileContains({ open: { c1: TICKET } });
    expect(store.getOpenById(1)).toMatchObject({ channelId: 'c1' });
  });

  it('is null for an id that is not open', () => {
    fileContains({ open: { c1: TICKET } });
    expect(store.getOpenById(999)).toBeNull();
  });

  it('updates a ticket in place', () => {
    fileContains({ open: { c1: TICKET } });
    store.updateTicket('c1', { claimedBy: 'mod1' });

    expect(store.getOpenByChannel('c1').claimedBy).toBe('mod1');
  });

  it('ignores an update to a ticket that is not open', () => {
    fileContains({ open: {} });
    expect(store.updateTicket('nope', { claimedBy: 'x' })).toBeNull();
  });

  it('moves a closed ticket into history', () => {
    fileContains({ open: { c1: TICKET } });
    const closed = store.closeTicket('c1', { closedBy: 'mod1', closedAt: 2000 });

    expect(closed).toMatchObject({ closedBy: 'mod1', closedAt: 2000 });
    expect(store.getOpenByChannel('c1')).toBeNull();
    expect(store.load().closed).toHaveLength(1);
  });

  it('ignores closing something that is not open', () => {
    fileContains({ open: {} });
    expect(store.closeTicket('nope', { closedBy: 'm' })).toBeNull();
  });

  it('counts a person\'s open tickets, for the per-user cap', () => {
    fileContains({
      open: {
        c1: TICKET,
        c2: { ...TICKET, id: 2, channelId: 'c2' },
        c3: { ...TICKET, id: 3, channelId: 'c3', userId: 'other' }
      }
    });

    expect(store.openCountFor('g1', 'u1')).toBe(2);
  });

  it('does not count tickets from another guild', () => {
    fileContains({ open: { c1: { ...TICKET, guildId: 'other' } } });
    expect(store.openCountFor('g1', 'u1')).toBe(0);
  });
});

describe('history', () => {
  it('returns open and closed together, newest first', () => {
    fileContains({
      open: { c2: { ...TICKET, id: 2, channelId: 'c2', createdAt: 3000 } },
      closed: [{ ...TICKET, id: 1, createdAt: 1000, closedAt: 2000 }]
    });

    expect(store.history({ guildId: 'g1' }).map(t => t.id)).toEqual([2, 1]);
  });

  it('narrows to one person', () => {
    fileContains({
      closed: [
        { ...TICKET, id: 1, userId: 'u1' },
        { ...TICKET, id: 2, userId: 'u2' }
      ]
    });

    expect(store.history({ guildId: 'g1', userId: 'u2' }).map(t => t.id)).toEqual([2]);
  });

  it('respects the limit', () => {
    fileContains({
      closed: Array.from({ length: 30 }, (_, i) => ({ ...TICKET, id: i + 1, createdAt: i }))
    });

    expect(store.history({ guildId: 'g1', limit: 5 })).toHaveLength(5);
  });

  it('is empty for a guild with no tickets', () => {
    fileMissing();
    expect(store.history({ guildId: 'g1' })).toEqual([]);
  });
});
