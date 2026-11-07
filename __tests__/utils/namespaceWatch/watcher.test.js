jest.mock('../../../utils/namespaceWatch/probe', () => ({
  runChecks: jest.fn(),
  readPatch: jest.fn()
}));
jest.mock('../../../utils/namespaceWatch/announce', () => ({
  announce: jest.fn(),
  buildAnnouncement: jest.fn()
}));
jest.mock('../../../utils/namespaceWatch/store', () => ({
  load: jest.fn(),
  recordResults: jest.fn()
}));
jest.mock('../../../utils/audit/log', () => ({ record: jest.fn() }));

const { runChecks, readPatch } = require('../../../utils/namespaceWatch/probe');
const { announce, buildAnnouncement } = require('../../../utils/namespaceWatch/announce');
const store = require('../../../utils/namespaceWatch/store');
const { record } = require('../../../utils/audit/log');
const { diffResults, runOnce, startNamespaceWatcher } = require('../../../utils/namespaceWatch/watcher');

const CONFIG = {
  blizzard: { region: 'us' },
  discord: { guildId: null },
  namespaceWatch: { enabled: true, channel: 'bot-activity-log', intervalMs: 60000 }
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  readPatch.mockResolvedValue({ patch: '1.60.1' });
  announce.mockResolvedValue({ posted: true, channelId: '1' });
  buildAnnouncement.mockReturnValue({ fake: 'embed' });
  store.recordResults.mockImplementation(results => results);
});

afterEach(() => jest.restoreAllMocks());

describe('diffResults', () => {
  it('announces nothing on a first run, however interesting the result', () => {
    const previous = { lastCheckedAt: null, patch: null, endpoints: {} };

    const { changes, baseline } = diffResults(
      [{ key: 'static.item', state: 'available' }],
      { store: previous }
    );

    expect(baseline).toBe(true);
    expect(changes).toEqual([]);
  });

  it('announces nothing for an endpoint seen for the first time', () => {
    const previous = { lastCheckedAt: 500, patch: null, endpoints: {} };

    const { changes } = diffResults([{ key: 'brand.new', state: 'available' }], { store: previous });

    expect(changes).toEqual([]);
  });

  it('reports a state change against what was recorded', () => {
    const previous = {
      lastCheckedAt: 500,
      patch: null,
      endpoints: { 'dynamic.token': { state: 'pending' } }
    };

    const { changes } = diffResults([{ key: 'dynamic.token', state: 'available' }], { store: previous });

    expect(changes).toEqual([{ key: 'dynamic.token', from: 'pending', to: 'available' }]);
  });

  it('stays quiet when nothing moved', () => {
    const previous = {
      lastCheckedAt: 500,
      patch: null,
      endpoints: { 'static.item': { state: 'available' } }
    };

    const { changes } = diffResults([{ key: 'static.item', state: 'available' }], { store: previous });

    expect(changes).toEqual([]);
  });

  it('swallows a transient error rather than reporting it as a change', () => {
    const previous = {
      lastCheckedAt: 500,
      patch: null,
      endpoints: { 'static.item': { state: 'available' } }
    };

    const { changes } = diffResults([{ key: 'static.item', state: 'error' }], { store: previous });

    expect(changes).toEqual([]);
  });
});

describe('runOnce', () => {
  it('records a baseline without announcing', async () => {
    store.load.mockReturnValue({ lastCheckedAt: null, patch: null, endpoints: {} });
    runChecks.mockResolvedValue({ results: [{ key: 'static.item', state: 'available' }], patch: null });

    const result = await runOnce({}, { config: CONFIG, now: 1000 });

    expect(result.baseline).toBe(true);
    expect(announce).not.toHaveBeenCalled();
    expect(store.recordResults).toHaveBeenCalled();
  });

  it('announces a change and writes an audit line', async () => {
    store.load.mockReturnValue({
      lastCheckedAt: 500,
      patch: '1.60.1',
      endpoints: { 'dynamic.realm-index': { state: 'pending' } }
    });
    runChecks.mockResolvedValue({
      results: [{ key: 'dynamic.realm-index', state: 'available' }],
      patch: '1.60.1'
    });

    const result = await runOnce({}, { config: CONFIG, now: 1000 });

    expect(result.changes).toHaveLength(1);
    expect(announce).toHaveBeenCalledWith({}, { fake: 'embed' }, {
      channel: 'bot-activity-log',
      guildId: null
    });
    expect(record).toHaveBeenCalledWith({}, expect.objectContaining({ automatic: true, ok: true }));
  });

  it('passes the region name through to the announcement', async () => {
    store.load.mockReturnValue({
      lastCheckedAt: 500,
      patch: '1.60.1',
      endpoints: { 'dynamic.token': { state: 'pending' } }
    });
    runChecks.mockResolvedValue({ results: [{ key: 'dynamic.token', state: 'available' }], patch: '1.60.1' });
    readPatch.mockResolvedValue({ patch: '1.60.1', regionName: 'CAMWOW North America' });

    await runOnce({}, { config: CONFIG, now: 1000 });

    expect(buildAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({ regionName: 'CAMWOW North America' })
    );
  });

  it('survives readPatch returning nothing at all', async () => {
    store.load.mockReturnValue({
      lastCheckedAt: 500,
      patch: '1.60.1',
      endpoints: { 'dynamic.token': { state: 'pending' } }
    });
    runChecks.mockResolvedValue({ results: [{ key: 'dynamic.token', state: 'available' }], patch: null });
    readPatch.mockResolvedValue(null);

    await runOnce({}, { config: CONFIG, now: 1000 });

    expect(buildAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({ regionName: null, patch: null })
    );
  });

  it('persists even when there is nothing to announce', async () => {
    store.load.mockReturnValue({
      lastCheckedAt: 500,
      patch: '1.60.1',
      endpoints: { 'static.item': { state: 'available' } }
    });
    runChecks.mockResolvedValue({ results: [{ key: 'static.item', state: 'available' }], patch: '1.60.1' });

    await runOnce({}, { config: CONFIG, now: 1000 });

    expect(announce).not.toHaveBeenCalled();
    expect(store.recordResults).toHaveBeenCalledWith(
      [{ key: 'static.item', state: 'available' }],
      { now: 1000, patch: '1.60.1' }
    );
  });

  it('announces a patch change on its own', async () => {
    store.load.mockReturnValue({ lastCheckedAt: 500, patch: '1.60.1', endpoints: {} });
    runChecks.mockResolvedValue({ results: [], patch: null });
    readPatch.mockResolvedValue({ patch: '1.61.0' });

    const result = await runOnce({}, { config: CONFIG, now: 1000 });

    expect(result.patchChanged).toBe(true);
    expect(announce).toHaveBeenCalled();
  });

  it('does not call a first-ever patch reading a change', async () => {
    store.load.mockReturnValue({ lastCheckedAt: 500, patch: null, endpoints: {} });
    runChecks.mockResolvedValue({ results: [], patch: null });
    readPatch.mockResolvedValue({ patch: '1.60.1' });

    expect((await runOnce({}, { config: CONFIG, now: 1000 })).patchChanged).toBe(false);
  });

  it('marks the audit line failed when the post did not land', async () => {
    store.load.mockReturnValue({
      lastCheckedAt: 500,
      patch: '1.60.1',
      endpoints: { 'dynamic.token': { state: 'pending' } }
    });
    runChecks.mockResolvedValue({ results: [{ key: 'dynamic.token', state: 'available' }], patch: '1.60.1' });
    announce.mockResolvedValue({ posted: false, reason: 'channel not found' });

    await runOnce({}, { config: CONFIG, now: 1000 });

    expect(record).toHaveBeenCalledWith({}, expect.objectContaining({ ok: false }));
  });

  it('counts the states it saw', async () => {
    store.load.mockReturnValue({ lastCheckedAt: 500, patch: null, endpoints: {} });
    runChecks.mockResolvedValue({
      results: [
        { key: 'a', state: 'available' },
        { key: 'b', state: 'pending' },
        { key: 'c', state: 'pending' }
      ],
      patch: null
    });

    expect((await runOnce({}, { config: CONFIG, now: 1000 })).summary)
      .toEqual({ available: 1, pending: 2 });
  });
});

describe('startNamespaceWatcher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does nothing when switched off', () => {
    const stop = startNamespaceWatcher({}, {
      config: { ...CONFIG, namespaceWatch: { ...CONFIG.namespaceWatch, enabled: false } }
    });

    jest.advanceTimersByTime(600000);

    expect(runChecks).not.toHaveBeenCalled();
    expect(typeof stop).toBe('function');
  });

  it('polls on the interval, not at startup', async () => {
    store.load.mockReturnValue({ lastCheckedAt: null, patch: null, endpoints: {} });
    runChecks.mockResolvedValue({ results: [], patch: null });

    startNamespaceWatcher({}, { config: CONFIG });

    expect(runChecks).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60000);
    await Promise.resolve();

    expect(runChecks).toHaveBeenCalled();
  });

  it('stops when the returned function is called', async () => {
    store.load.mockReturnValue({ lastCheckedAt: null, patch: null, endpoints: {} });
    runChecks.mockResolvedValue({ results: [], patch: null });

    const stop = startNamespaceWatcher({}, { config: CONFIG });
    stop();

    jest.advanceTimersByTime(600000);

    expect(runChecks).not.toHaveBeenCalled();
  });

  it('survives a poll that throws', async () => {
    store.load.mockReturnValue({ lastCheckedAt: null, patch: null, endpoints: {} });
    runChecks.mockRejectedValue(new Error('Blizzard is down'));

    startNamespaceWatcher({}, { config: CONFIG });

    jest.advanceTimersByTime(60000);
    await Promise.resolve();
    await Promise.resolve();

    expect(console.error).toHaveBeenCalled();
  });
});
