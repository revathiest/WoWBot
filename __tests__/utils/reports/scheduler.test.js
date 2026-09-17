jest.mock('../../../utils/reports/collect');
jest.mock('../../../utils/reports/history');
jest.mock('../../../utils/reports/config', () => ({
  ...jest.requireActual('../../../utils/reports/config'),
  loadConfig: jest.fn(),
  saveConfig: jest.fn()
}));

const { collectSnapshot } = require('../../../utils/reports/collect');
const { loadSnapshot, saveSnapshot } = require('../../../utils/reports/history');
const { loadConfig, saveConfig, DEFAULTS } = require('../../../utils/reports/config');
const { buildSnapshot } = require('../../../utils/reports/diff');

const {
  DAY_MS,
  buildAllReports,
  buildGuildReport,
  isDue,
  lastSlotAt,
  nextSlotAt,
  publishReports,
  runScheduledReports,
  startReportScheduler
} = require('../../../utils/reports/scheduler');

const APEX = { name: 'Apex', realm: 'Nightslayer', region: 'us', game: 'anniversary', channelId: null };

/** A config with the fields the scheduler reads. Daily, as shipped. */
function config(overrides = {}) {
  return { ...DEFAULTS, channelId: 'channel-1', guilds: [APEX], ...overrides };
}

/** The same, on the weekly schedule. */
function weekly(overrides = {}) {
  return config({ frequency: 'weekly', ...overrides });
}

// 2026-09-14 is a Monday.
const MONDAY_18_UTC = Date.UTC(2026, 8, 14, 18, 0, 0);

function snapshotOf(members = [{ name: 'Butud', level: 70 }], capturedAt = MONDAY_18_UTC) {
  return buildSnapshot({
    guild: { name: 'Apex', realm: 'Nightslayer', realmSlug: 'nightslayer', region: 'us' },
    capturedAt,
    members
  });
}

/** A discord.js client stub that records what was sent where. */
function fakeClient({ guildId = 'test-guild', isTextBased = true } = {}) {
  const send = jest.fn(async () => {});
  return {
    send,
    channels: {
      fetch: jest.fn(async id => ({ id, guildId, isTextBased: () => isTextBased, send }))
    }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  loadConfig.mockReturnValue(config());
  saveConfig.mockImplementation(changes => ({ ...config(), ...changes }));
  collectSnapshot.mockResolvedValue({ snapshot: snapshotOf(), warnings: [] });
  loadSnapshot.mockReturnValue(null);
});

afterEach(() => jest.restoreAllMocks());

describe('lastSlotAt — daily', () => {
  it('returns today when the hour has already passed', () => {
    const now = Date.UTC(2026, 8, 14, 20, 0, 0); // Monday 20:00
    expect(lastSlotAt(config({ hour: 18 }), now)).toBe(MONDAY_18_UTC);
  });

  it('steps back to yesterday when the hour has not come round yet', () => {
    const now = Date.UTC(2026, 8, 14, 9, 0, 0); // Monday 09:00
    expect(lastSlotAt(config({ hour: 18 }), now)).toBe(MONDAY_18_UTC - DAY_MS);
  });

  it('ignores the weekday entirely', () => {
    const thursday = Date.UTC(2026, 8, 17, 20, 0, 0);
    expect(lastSlotAt(config({ hour: 18, dayOfWeek: 1 }), thursday)).toBe(
      Date.UTC(2026, 8, 17, 18, 0, 0)
    );
  });

  it('crosses a month boundary correctly', () => {
    const now = Date.UTC(2026, 9, 1, 1, 0, 0); // 1 October, 01:00
    expect(lastSlotAt(config({ hour: 18 }), now)).toBe(Date.UTC(2026, 8, 30, 18, 0, 0));
  });
});

describe('lastSlotAt — weekly', () => {
  it('returns today when the hour has already passed', () => {
    const now = Date.UTC(2026, 8, 14, 20, 0, 0); // Monday 20:00
    expect(lastSlotAt(weekly({ dayOfWeek: 1, hour: 18 }), now)).toBe(MONDAY_18_UTC);
  });

  it('steps back a full week when today is the day but the hour has not come', () => {
    const now = Date.UTC(2026, 8, 14, 9, 0, 0); // Monday 09:00
    expect(lastSlotAt(weekly({ dayOfWeek: 1, hour: 18 }), now)).toBe(MONDAY_18_UTC - 7 * DAY_MS);
  });

  it('steps back to earlier in the week from a later day', () => {
    const now = Date.UTC(2026, 8, 17, 3, 0, 0); // Thursday
    expect(lastSlotAt(weekly({ dayOfWeek: 1, hour: 18 }), now)).toBe(MONDAY_18_UTC);
  });

  it('handles a Sunday schedule, where getUTCDay is zero', () => {
    const now = Date.UTC(2026, 8, 14, 12, 0, 0); // Monday
    expect(lastSlotAt(weekly({ dayOfWeek: 0, hour: 12 }), now)).toBe(Date.UTC(2026, 8, 13, 12, 0, 0));
  });

  it('crosses a month boundary correctly', () => {
    const now = Date.UTC(2026, 9, 2, 1, 0, 0); // Friday 2 October
    expect(lastSlotAt(weekly({ dayOfWeek: 1, hour: 18 }), now)).toBe(Date.UTC(2026, 8, 28, 18, 0, 0));
  });
});

describe('nextSlotAt', () => {
  it('is exactly a day after the last slot when daily', () => {
    const now = Date.UTC(2026, 8, 14, 20, 0, 0);
    expect(nextSlotAt(config(), now) - lastSlotAt(config(), now)).toBe(DAY_MS);
  });

  it('is exactly a week after the last slot when weekly', () => {
    const now = Date.UTC(2026, 8, 14, 20, 0, 0);
    expect(nextSlotAt(weekly(), now) - lastSlotAt(weekly(), now)).toBe(7 * DAY_MS);
  });
});

describe('isDue', () => {
  const now = Date.UTC(2026, 8, 14, 20, 0, 0); // Monday 20:00, slot was 18:00

  it('is due when the slot passed after the last post', () => {
    expect(isDue(config({ enabled: true, lastPostedAt: MONDAY_18_UTC - DAY_MS }), now)).toBe(true);
  });

  it('is not due again once posted after the slot', () => {
    expect(isDue(config({ enabled: true, lastPostedAt: MONDAY_18_UTC + 60_000 }), now)).toBe(false);
  });

  it('does not fire five times an hour across restarts', () => {
    const cfg = config({ enabled: true, lastPostedAt: MONDAY_18_UTC + 60_000 });

    for (let minute = 0; minute < 120; minute += 5) {
      expect(isDue(cfg, now + minute * 60_000)).toBe(false);
    }
  });

  it('still fires late when the bot was offline at the slot', () => {
    const wednesday = Date.UTC(2026, 8, 16, 9, 0, 0);
    expect(isDue(config({ enabled: true, lastPostedAt: MONDAY_18_UTC - 3 * DAY_MS }), wednesday)).toBe(true);
  });

  it('is never due while disabled', () => {
    expect(isDue(config({ enabled: false, lastPostedAt: null }), now)).toBe(false);
  });

  it('is never due with no guilds tracked', () => {
    expect(isDue(config({ enabled: true, guilds: [], lastPostedAt: null }), now)).toBe(false);
  });

  it('is never due when a guild has nowhere to post', () => {
    expect(isDue(config({ enabled: true, channelId: null, lastPostedAt: null }), now)).toBe(false);
  });

  it('treats a per-guild channel as enough when there is no default', () => {
    const cfg = config({
      enabled: true,
      channelId: null,
      guilds: [{ ...APEX, channelId: 'override' }],
      lastPostedAt: null
    });

    expect(isDue(cfg, now)).toBe(true);
  });
});

describe('buildGuildReport', () => {
  it('does not save a snapshot when previewing', async () => {
    await buildGuildReport(APEX, { persist: false });
    expect(saveSnapshot).not.toHaveBeenCalled();
  });

  it('saves a snapshot when posting for real', async () => {
    // Persisting is what consumes the baseline, so only the real run may do it.
    await buildGuildReport(APEX, { persist: true });
    expect(saveSnapshot).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ members: expect.any(Object) }));
  });

  it('diffs against the stored snapshot', async () => {
    loadSnapshot.mockReturnValue(snapshotOf([{ name: 'Butud', level: 69 }], MONDAY_18_UTC - 7 * DAY_MS));

    const { diff } = await buildGuildReport(APEX);

    expect(diff.isFirstRun).toBe(false);
    expect(diff.levelUps).toEqual([expect.objectContaining({ from: 69, to: 70 })]);
  });

  it('reports a first run when there is no history', async () => {
    expect((await buildGuildReport(APEX)).diff.isFirstRun).toBe(true);
  });
});

describe('buildAllReports', () => {
  it('builds one report per tracked guild', async () => {
    const cfg = config({ guilds: [APEX, { ...APEX, name: 'Second' }] });
    const { reports } = await buildAllReports({ config: cfg });

    expect(reports).toHaveLength(2);
  });

  it('lets the other guilds through when one fails', async () => {
    const cfg = config({ guilds: [APEX, { ...APEX, name: 'Broken' }] });
    collectSnapshot.mockImplementation(async guild => {
      if (guild.name === 'Broken') throw new Error('404');
      return { snapshot: snapshotOf(), warnings: [] };
    });

    const { reports, failures } = await buildAllReports({ config: cfg });

    expect(reports).toHaveLength(1);
    expect(failures).toEqual([expect.objectContaining({ guild: expect.objectContaining({ name: 'Broken' }) })]);
  });
});

describe('publishReports', () => {
  it('sends one message per channel, with a guild per embed', async () => {
    const client = fakeClient();
    const { reports } = await buildAllReports({
      config: config({ guilds: [APEX, { ...APEX, name: 'Second' }] })
    });

    await publishReports(client, reports, { config: config(), guildId: null });

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0][0].embeds).toHaveLength(2);
  });

  it('routes a guild with an override to its own channel', async () => {
    const client = fakeClient();
    const cfg = config({ guilds: [APEX, { ...APEX, name: 'Second', channelId: 'channel-2' }] });
    const { reports } = await buildAllReports({ config: cfg });

    await publishReports(client, reports, { config: cfg, guildId: null });

    expect(client.channels.fetch).toHaveBeenCalledWith('channel-1');
    expect(client.channels.fetch).toHaveBeenCalledWith('channel-2');
  });

  it('refuses to post outside the guild this instance is pinned to', async () => {
    // Posting is not an interaction, so nothing else stops a second instance
    // sharing this token from double-posting.
    const client = fakeClient({ guildId: 'production-guild' });
    const { reports } = await buildAllReports({ config: config() });

    const delivered = await publishReports(client, reports, { config: config(), guildId: 'dev-guild' });

    expect(client.send).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
  });

  it('skips a channel that is not text-based', async () => {
    const client = fakeClient({ isTextBased: false });
    const { reports } = await buildAllReports({ config: config() });

    await publishReports(client, reports, { config: config(), guildId: null });

    expect(client.send).not.toHaveBeenCalled();
  });

  it('survives a channel it cannot fetch', async () => {
    const client = fakeClient();
    client.channels.fetch.mockRejectedValue(new Error('Missing Access'));
    const { reports } = await buildAllReports({ config: config() });

    await expect(
      publishReports(client, reports, { config: config(), guildId: null })
    ).resolves.toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it('skips a guild with no channel at all', async () => {
    const cfg = config({ channelId: null });
    const { reports } = await buildAllReports({ config: cfg });
    const client = fakeClient();

    await publishReports(client, reports, { config: cfg, guildId: null });

    expect(client.channels.fetch).not.toHaveBeenCalled();
  });
});

describe('runScheduledReports', () => {
  it('records the run even when nothing could be delivered', async () => {
    // Otherwise a bad channel means a retry every five minutes, forever.
    const client = fakeClient();
    client.channels.fetch.mockRejectedValue(new Error('Missing Access'));

    await runScheduledReports(client, { now: MONDAY_18_UTC, config: config() });

    expect(saveConfig).toHaveBeenCalledWith({ lastPostedAt: MONDAY_18_UTC });
  });

  it('persists snapshots, so next week has a baseline', async () => {
    await runScheduledReports(fakeClient(), { now: MONDAY_18_UTC, config: config() });
    expect(saveSnapshot).toHaveBeenCalled();
  });
});

describe('startReportScheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does nothing while reports are switched off', () => {
    loadConfig.mockReturnValue(config({ enabled: false }));
    startReportScheduler(fakeClient(), { intervalMs: 1000, now: () => MONDAY_18_UTC + 60_000 });

    jest.advanceTimersByTime(5000);

    expect(collectSnapshot).not.toHaveBeenCalled();
  });

  it('runs once the slot has passed', async () => {
    loadConfig.mockReturnValue(
      config({ enabled: true, lastPostedAt: MONDAY_18_UTC - 2 * DAY_MS })
    );
    startReportScheduler(fakeClient(), { intervalMs: 1000, now: () => MONDAY_18_UTC + 60_000 });

    jest.advanceTimersByTime(1000);
    // The tick resolves the server member list before it builds anything, so a
    // single microtask flush is not enough to reach collectSnapshot.
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    expect(collectSnapshot).toHaveBeenCalled();
  });

  it('stops when the returned function is called', () => {
    loadConfig.mockReturnValue(config({ enabled: true, lastPostedAt: null }));
    const stop = startReportScheduler(fakeClient(), { intervalMs: 1000, now: () => MONDAY_18_UTC });

    stop();
    jest.advanceTimersByTime(10_000);

    expect(collectSnapshot).not.toHaveBeenCalled();
  });
});
