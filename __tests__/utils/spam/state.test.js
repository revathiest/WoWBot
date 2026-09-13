const state = require('../../../utils/spam/state');

beforeEach(() => state.clearAllState());
afterEach(() => jest.restoreAllMocks());

describe('normalize', () => {
  it('collapses case and whitespace so trivial edits do not evade duplicate checks', () => {
    expect(state.normalize('  Hello   WORLD  ')).toBe('hello world');
    expect(state.normalize('Hello\n\nworld')).toBe('hello world');
  });

  it('handles nullish input', () => {
    expect(state.normalize(undefined)).toBe('');
  });
});

describe('record and windows', () => {
  const base = { guildId: 'g1', userId: 'u1', channelId: 'c1', content: 'hello world' };

  it('accumulates timestamps and messages', () => {
    state.record({ ...base, now: 1000 });
    state.record({ ...base, now: 1500 });

    expect(state.timesWithin('g1', 'u1', 5000, 2000)).toHaveLength(2);
    expect(state.messagesWithin('g1', 'u1', 5000, 2000)).toHaveLength(2);
  });

  it('excludes entries outside the requested window', () => {
    state.record({ ...base, now: 1000 });
    state.record({ ...base, now: 9000 });

    expect(state.timesWithin('g1', 'u1', 5000, 10000)).toHaveLength(1);
  });

  it('keeps users separate', () => {
    state.record({ ...base, now: 1000 });
    state.record({ ...base, userId: 'u2', now: 1000 });

    expect(state.timesWithin('g1', 'u1', 5000, 1500)).toHaveLength(1);
    expect(state.timesWithin('g1', 'u2', 5000, 1500)).toHaveLength(1);
  });

  it('keeps guilds separate', () => {
    state.record({ ...base, now: 1000 });

    expect(state.timesWithin('g2', 'u1', 5000, 1500)).toHaveLength(0);
  });

  it('drops entries beyond the retention ceiling as it records', () => {
    state.record({ ...base, now: 0 });
    const { times } = state.record({ ...base, now: state.MAX_RETENTION_MS + 1000 });

    expect(times).toHaveLength(1);
  });

  it('returns an empty window for an unknown user', () => {
    expect(state.timesWithin('g1', 'nobody', 5000, 1000)).toEqual([]);
    expect(state.messagesWithin('g1', 'nobody', 5000, 1000)).toEqual([]);
  });
});

describe('clearUserState', () => {
  it('forgets one user without touching another', () => {
    state.record({ guildId: 'g1', userId: 'u1', channelId: 'c1', content: 'hello world', now: 1000 });
    state.record({ guildId: 'g1', userId: 'u2', channelId: 'c1', content: 'hello world', now: 1000 });

    state.clearUserState('g1', 'u1');

    expect(state.timesWithin('g1', 'u1', 5000, 1500)).toHaveLength(0);
    expect(state.timesWithin('g1', 'u2', 5000, 1500)).toHaveLength(1);
  });
});

describe('sweep', () => {
  it('removes users whose entries have all aged out', () => {
    state.record({ guildId: 'g1', userId: 'u1', channelId: 'c1', content: 'hello world', now: 1000 });
    expect(state.stateSize().users).toBe(1);

    const removed = state.sweep(1000 + state.MAX_RETENTION_MS + 1);

    expect(removed).toBe(1);
    expect(state.stateSize()).toEqual({ users: 0, messageLists: 0 });
  });

  it('keeps users who are still active', () => {
    state.record({ guildId: 'g1', userId: 'u1', channelId: 'c1', content: 'hello world', now: 1000 });

    expect(state.sweep(2000)).toBe(0);
    expect(state.stateSize().users).toBe(1);
  });
});

describe('sweepIfDue', () => {
  it('runs at most once per interval', () => {
    state.record({ guildId: 'g1', userId: 'u1', channelId: 'c1', content: 'hello world', now: 0 });

    const first = state.MAX_RETENTION_MS + 1;
    expect(state.sweepIfDue(first)).toBe(1);

    // Immediately after, the gate blocks a second sweep.
    state.record({ guildId: 'g1', userId: 'u2', channelId: 'c1', content: 'hello world', now: first });
    expect(state.sweepIfDue(first + 100)).toBe(0);
  });

  it('runs again once the interval has passed', () => {
    state.sweepIfDue(state.SWEEP_INTERVAL_MS + 1);
    state.record({ guildId: 'g1', userId: 'u1', channelId: 'c1', content: 'hello world', now: 0 });

    const later = state.SWEEP_INTERVAL_MS * 2 + state.MAX_RETENTION_MS + 2;
    expect(state.sweepIfDue(later)).toBe(1);
  });
});
