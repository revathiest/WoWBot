jest.mock('../../../utils/reports/collect');
jest.mock('../../../utils/reports/history');
jest.mock('../../../utils/reports/killHistory');
jest.mock('../../../utils/reports/reportHistory');
jest.mock('../../../utils/audit/log');
jest.mock('../../../utils/reports/config', () => ({
  ...jest.requireActual('../../../utils/reports/config'),
  loadConfig: jest.fn(),
  saveConfig: jest.fn()
}));

const { collectSnapshot } = require('../../../utils/reports/collect');
const { loadSnapshot, saveSnapshot } = require('../../../utils/reports/history');
const { appendKillEntry, loadKillHistory } = require('../../../utils/reports/killHistory');
const { appendReportHistoryEntry } = require('../../../utils/reports/reportHistory');
const { record } = require('../../../utils/audit/log');
const { loadConfig, saveConfig, DEFAULTS } = require('../../../utils/reports/config');
const { buildSnapshot } = require('../../../utils/reports/diff');

const {
  DAY_MS,
  buildAllReports,
  buildGuildReport,
  clearOwnMessages,
  isDue,
  lastSlotAt,
  nextSlotAt,
  presentIdsFor,
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
  loadKillHistory.mockReturnValue([]);
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

  it('defaults to right now when no instant is given', () => {
    expect(lastSlotAt(config())).toBeLessThanOrEqual(Date.now());
    expect(nextSlotAt(config())).toBeGreaterThan(Date.now());
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

  it('defaults to right now when no instant is given', () => {
    // A slot from decades ago is due under any real "now".
    expect(isDue(config({ enabled: true, hour: 0, lastPostedAt: null }))).toBe(true);
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

  it('appends to the long-running history log when posting for real, not when previewing', async () => {
    await buildGuildReport(APEX, { persist: true });
    expect(appendReportHistoryEntry).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ isFirstRun: expect.any(Boolean) }));

    appendReportHistoryEntry.mockClear();
    await buildGuildReport(APEX, { persist: false });
    expect(appendReportHistoryEntry).not.toHaveBeenCalled();
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

  it('does not append kill history when previewing', async () => {
    await buildGuildReport(APEX, { persist: false });
    expect(appendKillEntry).not.toHaveBeenCalled();
  });

  it('appends today\'s kill totals when posting for real', async () => {
    collectSnapshot.mockResolvedValue({
      snapshot: snapshotOf([{ name: 'Butud', level: 70, kills: 500 }]),
      warnings: []
    });

    await buildGuildReport(APEX, { persist: true, now: MONDAY_18_UTC });

    expect(appendKillEntry).toHaveBeenCalledWith(
      expect.any(String),
      { capturedAt: MONDAY_18_UTC, kills: { butud: 500 } }
    );
  });

  it('omits members with no kill data from the appended entry', async () => {
    collectSnapshot.mockResolvedValue({
      snapshot: snapshotOf([{ name: 'NoKills', level: 1, kills: null }]),
      warnings: []
    });

    await buildGuildReport(APEX, { persist: true, now: MONDAY_18_UTC });

    expect(appendKillEntry).toHaveBeenCalledWith(expect.any(String), {
      capturedAt: MONDAY_18_UTC,
      kills: {}
    });
  });

  it('builds a kill tally independent of this guild\'s report frequency', async () => {
    loadKillHistory.mockReturnValue([{ capturedAt: MONDAY_18_UTC - DAY_MS, kills: { butud: 60 } }]);
    collectSnapshot.mockResolvedValue({
      snapshot: snapshotOf([{ name: 'Butud', level: 70, kills: 70 }]),
      warnings: []
    });

    const { killTally } = await buildGuildReport(APEX, { now: MONDAY_18_UTC });

    expect(killTally).toEqual([
      expect.objectContaining({ name: 'Butud', today: 10, lifetime: 70 })
    ]);
  });

  /** The embed field named "Most Kills <period>", whichever period it is. */
  function killTallyField(embed) {
    return (embed.toJSON().fields ?? []).find(field => field.name.startsWith('📅 Most Kills'));
  }

  // These need an actual gain in the tally — an empty one adds no field at
  // all, which would make the label assertion vacuous.
  function withAGain() {
    loadKillHistory.mockReturnValue([{ capturedAt: MONDAY_18_UTC - DAY_MS, kills: { butud: 60 } }]);
    collectSnapshot.mockResolvedValue({
      snapshot: snapshotOf([{ name: 'Butud', level: 70, kills: 70 }]),
      warnings: []
    });
  }

  it('labels the kill-tally field "Today" on the default, daily config', async () => {
    withAGain();
    const { embed } = await buildGuildReport(APEX, { now: MONDAY_18_UTC });
    expect(killTallyField(embed).name).toBe('📅 Most Kills Today');
  });

  it('defaults the kill-tally label to the loaded report config\'s frequency', async () => {
    // No `frequency` passed explicitly — buildGuildReport is also called
    // directly (e.g. by tools or future callers), not only through
    // buildAllReports, so it must fall back to the real config itself.
    withAGain();
    loadConfig.mockReturnValue(weekly());

    const { embed } = await buildGuildReport(APEX, { now: MONDAY_18_UTC });
    expect(killTallyField(embed).name).toBe('📅 Most Kills This Week');
  });

  it('prefers an explicit frequency over the loaded config', async () => {
    withAGain();
    loadConfig.mockReturnValue(config());

    const { embed } = await buildGuildReport(APEX, { now: MONDAY_18_UTC, frequency: 'weekly' });
    expect(killTallyField(embed).name).toBe('📅 Most Kills This Week');
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

  it("passes its own config's frequency to every guild's report, not each guild's own loaded config", async () => {
    loadKillHistory.mockReturnValue([{ capturedAt: MONDAY_18_UTC - DAY_MS, kills: { butud: 60 } }]);
    collectSnapshot.mockResolvedValue({
      snapshot: snapshotOf([{ name: 'Butud', level: 70, kills: 70 }]),
      warnings: []
    });

    const { reports } = await buildAllReports({ config: weekly(), now: MONDAY_18_UTC });
    const field = (reports[0].embed.toJSON().fields ?? []).find(f => f.name.startsWith('📅 Most Kills'));

    expect(field.name).toBe('📅 Most Kills This Week');
  });

  it('falls back to the loaded config and right now when called with no options at all', async () => {
    const { reports } = await buildAllReports();
    expect(reports).toHaveLength(1);
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

  it('attaches both a roster button and a kill-tally button per guild', async () => {
    const client = fakeClient();
    const { reports } = await buildAllReports({ config: config() });

    await publishReports(client, reports, { config: config(), guildId: null });

    const components = client.send.mock.calls[0][0].components;
    const customIds = components.flatMap(row => row.components.map(c => c.data.custom_id));

    expect(customIds.some(id => id.startsWith('report:roster:'))).toBe(true);
    expect(customIds.some(id => id.startsWith('report:kills:'))).toBe(true);
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

  it('clears the channel first when clearChannel is on', async () => {
    const client = fakeClient();
    // clearOwnMessages's own branches are covered directly, below; this just
    // has to prove publishReports actually calls it when asked to.
    client.channels.fetch.mockResolvedValue({
      id: 'channel-1',
      guildId: 'test-guild',
      isTextBased: () => true,
      send: client.send,
      messages: { fetch: jest.fn().mockResolvedValue(new Map()) }
    });

    const cfg = config({ clearChannel: true });
    const { reports } = await buildAllReports({ config: cfg });

    await publishReports(client, reports, { config: cfg, guildId: null });

    expect(client.send).toHaveBeenCalled();
  });

  it('leaves previous messages alone when clearChannel is off', async () => {
    const client = fakeClient();
    const cfg = config({ clearChannel: false });
    const { reports } = await buildAllReports({ config: cfg });

    await publishReports(client, reports, { config: cfg, guildId: null });

    // No `messages` manager on this stub at all — if clearOwnMessages were
    // called, awaiting `channel.messages.fetch` would throw.
    expect(client.send).toHaveBeenCalled();
  });

  it('falls back to the loaded config and this instance\'s own guild scope when called with just a client and reports', async () => {
    const client = fakeClient();
    const { reports } = await buildAllReports({ config: config() });

    await expect(publishReports(client, reports)).resolves.toBeDefined();
  });
});

describe('clearOwnMessages', () => {
  /** A fake channel with just enough of the discord.js message-manager shape. */
  function fakeChannel(messages) {
    return {
      id: 'channel-1',
      messages: { fetch: jest.fn().mockResolvedValue(new Map(messages.map((m, i) => [i, m]))) },
      bulkDelete: jest.fn().mockResolvedValue(undefined)
    };
  }

  function message({ authorId = 'bot-1', id = 'm1', createdTimestamp = Date.now() } = {}) {
    return { id, author: { id: authorId }, createdTimestamp, delete: jest.fn().mockResolvedValue(undefined) };
  }

  const client = { user: { id: 'bot-1' } };

  it('deletes nothing and returns 0 when the bot has posted nothing here', async () => {
    const channel = fakeChannel([message({ authorId: 'someone-else' })]);

    expect(await clearOwnMessages(channel, client)).toBe(0);
    expect(channel.bulkDelete).not.toHaveBeenCalled();
  });

  it('excludes the given message id, e.g. the interaction\'s own deferred reply', async () => {
    const own = message({ id: 'reply-1' });
    const channel = fakeChannel([own, message({ id: 'older' })]);

    const count = await clearOwnMessages(channel, client, 'reply-1');

    expect(count).toBe(1);
    expect(channel.bulkDelete).toHaveBeenCalledWith([expect.objectContaining({ id: 'older' })], true);
  });

  it('defaults to excluding nothing when no id is given', async () => {
    const channel = fakeChannel([message({ id: 'a' }), message({ id: 'b' })]);

    const count = await clearOwnMessages(channel, client);

    expect(count).toBe(2);
  });

  it('bulk-deletes recent messages and deletes stale ones one at a time', async () => {
    const fresh = message({ id: 'fresh', createdTimestamp: Date.now() });
    const stale = message({ id: 'stale', createdTimestamp: Date.now() - 20 * DAY_MS });
    const channel = fakeChannel([fresh, stale]);

    const count = await clearOwnMessages(channel, client);

    expect(count).toBe(2);
    expect(channel.bulkDelete).toHaveBeenCalledWith([fresh], true);
    expect(stale.delete).toHaveBeenCalled();
  });

  it('skips bulkDelete entirely when every message is stale', async () => {
    const stale = message({ id: 'stale', createdTimestamp: Date.now() - 20 * DAY_MS });
    const channel = fakeChannel([stale]);

    await clearOwnMessages(channel, client);

    expect(channel.bulkDelete).not.toHaveBeenCalled();
    expect(stale.delete).toHaveBeenCalled();
  });

  it('does not let one stale message that cannot be deleted stop the others', async () => {
    const stale = message({ id: 'stale', createdTimestamp: Date.now() - 20 * DAY_MS });
    stale.delete.mockRejectedValue(new Error('Unknown Message'));
    const channel = fakeChannel([stale]);

    await expect(clearOwnMessages(channel, client)).resolves.toBe(1);
  });

  it('never lets a tidy-up failure stop the report from going out', async () => {
    const channel = {
      id: 'channel-1',
      messages: { fetch: jest.fn().mockRejectedValue(new Error('Missing Access')) }
    };

    expect(await clearOwnMessages(channel, client)).toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('presentIdsFor', () => {
  function clientWith(channel) {
    return { channels: { fetch: jest.fn().mockResolvedValue(channel) } };
  }

  it('is null when there is no channel to read members from at all', async () => {
    const cfg = config({ channelId: null, guilds: [{ ...APEX, channelId: null }] });
    expect(await presentIdsFor({ channels: { fetch: jest.fn() } }, cfg)).toBeNull();
  });

  it('falls back to a per-guild channel when there is no default one', async () => {
    const cfg = config({ channelId: null, guilds: [{ ...APEX, channelId: 'override' }] });
    const client = clientWith({ guild: { members: { fetch: jest.fn().mockResolvedValue(new Map()) } } });

    await presentIdsFor(client, cfg);

    expect(client.channels.fetch).toHaveBeenCalledWith('override');
  });

  it('is null when the channel has no guild (e.g. a DM)', async () => {
    const client = clientWith({ guild: null });
    expect(await presentIdsFor(client, config())).toBeNull();
  });

  it('reads the member ids from the channel\'s guild', async () => {
    const members = new Map([['u1', {}], ['u2', {}]]);
    const client = clientWith({ guild: { members: { fetch: jest.fn().mockResolvedValue(members) } } });

    const ids = await presentIdsFor(client, config());

    expect(ids).toEqual(new Set(['u1', 'u2']));
  });

  it('is null, not a thrown error, when the channel cannot be fetched', async () => {
    const client = { channels: { fetch: jest.fn().mockRejectedValue(new Error('Missing Access')) } };
    expect(await presentIdsFor(client, config())).toBeNull();
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

  it('appends the daily kill history, even on a weekly-frequency guild', async () => {
    await runScheduledReports(fakeClient(), { now: MONDAY_18_UTC, config: weekly() });
    expect(appendKillEntry).toHaveBeenCalled();
  });

  it('records the failure count when a guild could not be built', async () => {
    collectSnapshot.mockRejectedValue(new Error('404'));

    await runScheduledReports(fakeClient(), { now: MONDAY_18_UTC, config: config() });

    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ detail: expect.stringContaining('failed'), ok: false })
    );
  });

  it('falls back to the loaded config and right now when called with no options at all', async () => {
    await runScheduledReports(fakeClient());
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ lastPostedAt: expect.any(Number) }));
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

  it('does not double-post when a tick is still running at the next interval', async () => {
    loadConfig.mockReturnValue(config({ enabled: true, lastPostedAt: null }));
    const stop = startReportScheduler(fakeClient(), { intervalMs: 10, now: () => MONDAY_18_UTC });

    // Both intervals elapse before either tick's first await yields back to
    // the microtask queue, so the second must see `running` already true.
    jest.advanceTimersByTime(25);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    expect(collectSnapshot).toHaveBeenCalledTimes(1);
    stop();
  });

  it('logs, rather than crashes the process, when a tick throws', async () => {
    collectSnapshot.mockRejectedValue(new Error('boom'));
    loadConfig.mockReturnValue(config({ enabled: true, lastPostedAt: null }));
    // saveConfig is what runScheduledReports calls last; throwing there is an
    // easy way to make the whole tick reject regardless of per-guild failures.
    saveConfig.mockImplementation(() => {
      throw new Error('disk full');
    });

    const stop = startReportScheduler(fakeClient(), { intervalMs: 10, now: () => MONDAY_18_UTC });

    jest.advanceTimersByTime(10);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('scheduler failed'),
      expect.any(Error)
    );
    stop();
  });

  it('defaults to CHECK_INTERVAL_MS and the real clock when called with no options', async () => {
    const { CHECK_INTERVAL_MS } = require('../../../utils/reports/scheduler');
    // null lastPostedAt is always due (see isDue), so this is due under
    // whatever the real wall clock happens to be when the test runs.
    loadConfig.mockReturnValue(config({ enabled: true, lastPostedAt: null }));
    const stop = startReportScheduler(fakeClient());

    jest.advanceTimersByTime(CHECK_INTERVAL_MS);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    expect(collectSnapshot).toHaveBeenCalled();
    stop();
  });
});
