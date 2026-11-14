jest.mock('../../utils/reports/config', () => ({
  ...jest.requireActual('../../utils/reports/config'),
  loadConfig: jest.fn(),
  saveConfig: jest.fn(),
  trackGuild: jest.fn(),
  untrackGuild: jest.fn()
}));
jest.mock('../../utils/reports/scheduler');
jest.mock('../../utils/reports/history');
jest.mock('../../utils/reports/killHistory');
jest.mock('../../utils/reports/reportHistory');
jest.mock('../../utils/reports/excel');
jest.mock('../../utils/reports/links');

const { PermissionFlagsBits } = require('discord.js');

const {
  DEFAULTS,
  MAX_TRACKED_GUILDS,
  loadConfig,
  saveConfig,
  trackGuild,
  untrackGuild
} = require('../../utils/reports/config');
const { buildAllReports, publishReports, nextSlotAt } = require('../../utils/reports/scheduler');
const { deleteSnapshot, loadSnapshot } = require('../../utils/reports/history');
const { deleteKillHistory } = require('../../utils/reports/killHistory');
const { deleteReportHistory, loadReportHistory } = require('../../utils/reports/reportHistory');
const { buildReportWorkbookBuffer } = require('../../utils/reports/excel');
const { buildOwnerIndex } = require('../../utils/reports/links');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const command = require('../../commands/wow/report');
const { createInteraction } = require('../helpers/interaction');

const APEX = { name: 'Apex', region: 'eu', channelId: null };

function config(overrides = {}) {
  return { ...DEFAULTS, channelId: 'channel-1', guilds: [APEX], ...overrides };
}

/** An interaction for /report, defaulting to a user who may configure it. */
function interaction({ subcommand, subcommandGroup = null, options = {}, permissions = true } = {}) {
  return createInteraction({
    commandName: 'report',
    subcommand,
    subcommandGroup,
    options,
    permissions
  });
}

/**
 * The last payload, whichever way the command answered. Configure and status
 * reply directly; the expensive subcommands defer and then edit.
 */
function payloadOf(fake) {
  const call = fake.editReply.mock.calls.at(-1) ?? fake.reply.mock.calls.at(-1);
  return call[0];
}

/** The text of the last answer. */
function said(fake) {
  const payload = payloadOf(fake);
  return typeof payload === 'string' ? payload : payload.content;
}

beforeEach(() => {
  jest.clearAllMocks();
  loadConfig.mockReturnValue(config());
  saveConfig.mockImplementation(changes => ({ ...config(), ...changes }));
  trackGuild.mockReturnValue({ added: true, reason: null });
  untrackGuild.mockReturnValue({ removed: true, removedGuilds: [APEX] });
  buildAllReports.mockResolvedValue({
    reports: [{ key: 'eu:apex', guild: APEX, embed: { fake: true }, killTally: [] }],
    failures: []
  });
  publishReports.mockResolvedValue(['channel-1']);
  nextSlotAt.mockReturnValue(1_800_000_000_000);
  loadSnapshot.mockReturnValue({ capturedAt: 1 });
  loadReportHistory.mockReturnValue([]);
  buildOwnerIndex.mockReturnValue(new Map());
  buildReportWorkbookBuffer.mockResolvedValue(Buffer.from('fake-xlsx'));
});

describe('command shape', () => {
  it('is named /report and declares Manage Server', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('report');
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
  });

  it('exposes the subcommands the workflow needs', () => {
    const names = command.data.toJSON().options.map(option => option.name);
    expect(names).toEqual(
      expect.arrayContaining(['status', 'now', 'post', 'excel', 'track', 'untrack', 'configure'])
    );
  });

  it('takes no realm option — guilds have none', () => {
    const track = command.data.toJSON().options.find(option => option.name === 'track');
    expect(track.options.map(option => option.name)).not.toContain('realm');
  });
});

describe('permissions', () => {
  it('refuses a member without Manage Server', async () => {
    // The UI flag can be overridden per guild, so the check is repeated in code.
    const fake = interaction({ subcommand: 'status', permissions: false });
    await command.execute(fake);

    expect(said(fake)).toContain('Manage Server');
    expect(loadConfig).not.toHaveBeenCalled();
  });
});

describe('/report status', () => {
  it('shows a daily schedule when enabled', async () => {
    loadConfig.mockReturnValue(config({ enabled: true, frequency: 'daily', hour: 18 }));
    const fake = interaction({ subcommand: 'status' });

    await command.execute(fake);

    expect(payloadOf(fake).embeds[0].toJSON().description).toContain('Daily');
  });

  it('names the weekday only on a weekly schedule', async () => {
    loadConfig.mockReturnValue(
      config({ enabled: true, frequency: 'weekly', dayOfWeek: 1, hour: 18 })
    );
    const fake = interaction({ subcommand: 'status' });

    await command.execute(fake);

    expect(payloadOf(fake).embeds[0].toJSON().description).toContain('Monday');
  });

  it('says how to turn it on when disabled', async () => {
    const fake = interaction({ subcommand: 'status' });
    await command.execute(fake);

    expect(payloadOf(fake).embeds[0].toJSON().description).toContain('/report configure enabled');
  });

  it('flags a tracked guild with nowhere to post', async () => {
    const embed = command.buildStatusEmbed(config({ channelId: null })).toJSON();

    expect(embed.fields.some(field => field.name.includes('No channel'))).toBe(true);
  });

  it('says which guilds have no baseline yet', () => {
    loadSnapshot.mockReturnValue(null);

    const embed = command.buildStatusEmbed(config()).toJSON();

    expect(embed.fields.some(field => field.name === 'Awaiting a baseline')).toBe(true);
  });

  it('prompts for a first guild when none are tracked', () => {
    const embed = command.buildStatusEmbed(config({ guilds: [] })).toJSON();

    expect(embed.fields.find(field => field.name.startsWith('Tracked guilds')).value).toContain(
      '/report track'
    );
  });

  it('describes a guild by name and region alone', () => {
    expect(command.describeGuild(APEX, config())).toContain('**Apex** (EU)');
  });

  it('says when previous reports are being cleared before each post', () => {
    const embed = command.buildStatusEmbed(config({ clearChannel: true })).toJSON();

    expect(embed.fields.find(f => f.name === 'Clear before posting').value).toContain('yes');
  });

  it('leaves previous reports in place when clearChannel is off', () => {
    const embed = command.buildStatusEmbed(config({ clearChannel: false })).toJSON();

    expect(embed.fields.find(f => f.name === 'Clear before posting').value).toBe('no');
  });

  it('shows the next report time when one is due', () => {
    nextSlotAt.mockReturnValue(1_800_000_000_000);
    const embed = command.buildStatusEmbed(config({ enabled: true })).toJSON();

    expect(embed.fields.find(f => f.name === 'Next report').value).not.toBe('_unknown_');
  });

  it('falls back to "unknown" when the next slot cannot be determined', () => {
    nextSlotAt.mockReturnValue(null);
    const embed = command.buildStatusEmbed(config({ enabled: true })).toJSON();

    expect(embed.fields.find(f => f.name === 'Next report').value).toBe('_unknown_');
  });
});

describe('/report track', () => {
  it('tracks a guild with just the name and region, since there is no realm', async () => {
    const fake = interaction({ subcommand: 'track', options: { guild: 'Apex', region: 'eu' } });
    await command.execute(fake);

    expect(trackGuild).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Apex', region: 'eu' })
    );
    expect(said(fake)).toContain('Now reporting on');
  });

  it('accepts a per-guild channel', async () => {
    const fake = interaction({
      subcommand: 'track',
      options: { guild: 'Apex', channel: { id: 'channel-9' } }
    });

    await command.execute(fake);

    expect(trackGuild).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'channel-9' }));
  });

  it('reports a duplicate rather than tracking it twice', async () => {
    trackGuild.mockReturnValue({ added: false, reason: 'duplicate' });
    const fake = interaction({ subcommand: 'track', options: { guild: 'Apex' } });

    await command.execute(fake);

    expect(said(fake)).toContain('already tracked');
  });

  it('names the ceiling when the list is full', async () => {
    trackGuild.mockReturnValue({ added: false, reason: 'full' });
    const fake = interaction({ subcommand: 'track', options: { guild: 'Apex' } });

    await command.execute(fake);

    expect(said(fake)).toContain(String(MAX_TRACKED_GUILDS));
  });

  it('falls back to a generic refusal for any other reason', async () => {
    trackGuild.mockReturnValue({ added: false, reason: null });
    const fake = interaction({ subcommand: 'track', options: { guild: 'Apex' } });

    await command.execute(fake);

    expect(said(fake)).toContain('could not be added');
  });
});

describe('/report untrack', () => {
  it('removes the guild and discards its history', async () => {
    const fake = interaction({ subcommand: 'untrack', options: { guild: 'Apex' } });
    await command.execute(fake);

    expect(deleteSnapshot).toHaveBeenCalled();
    expect(deleteKillHistory).toHaveBeenCalled();
    expect(deleteReportHistory).toHaveBeenCalled();
    expect(said(fake)).toContain('No longer reporting');
  });

  it('narrows by region when two tracked guilds share a name', async () => {
    const fake = interaction({ subcommand: 'untrack', options: { guild: 'Apex', region: 'eu' } });
    await command.execute(fake);

    expect(untrackGuild).toHaveBeenCalledWith({ name: 'Apex', region: 'eu' });
  });

  it('reports a guild that was not tracked', async () => {
    untrackGuild.mockReturnValue({ removed: false, removedGuilds: [] });
    const fake = interaction({ subcommand: 'untrack', options: { guild: 'Nobody' } });

    await command.execute(fake);

    expect(said(fake)).toContain('not tracked');
    expect(deleteSnapshot).not.toHaveBeenCalled();
  });
});

describe('/report now', () => {
  it('defers, because building a report takes far longer than three seconds', async () => {
    const fake = interaction({ subcommand: 'now' });
    await command.execute(fake);

    expect(fake.deferReply).toHaveBeenCalled();
  });

  it('previews without saving a snapshot or resetting the week', async () => {
    const fake = interaction({ subcommand: 'now' });
    await command.execute(fake);

    expect(buildAllReports).toHaveBeenCalledWith(expect.objectContaining({ persist: false }));
    expect(publishReports).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
    expect(said(fake)).toContain('Preview only');
  });

  it('asks for a guild first when none are tracked', async () => {
    loadConfig.mockReturnValue(config({ guilds: [] }));
    const fake = interaction({ subcommand: 'now' });

    await command.execute(fake);

    expect(said(fake)).toContain('/report track');
    expect(buildAllReports).not.toHaveBeenCalled();
  });

  it('shows what failed alongside what worked', async () => {
    buildAllReports.mockResolvedValue({
      reports: [{ embed: { fake: true } }],
      failures: [{ guild: APEX, error: new Error('boom') }]
    });

    const fake = interaction({ subcommand: 'now' });
    await command.execute(fake);

    expect(payloadOf(fake).embeds).toHaveLength(2);
  });
});

describe('/report post', () => {
  it('publishes, persists, and starts a new week', async () => {
    const fake = interaction({ subcommand: 'post' });
    await command.execute(fake);

    expect(buildAllReports).toHaveBeenCalledWith(expect.objectContaining({ persist: true }));
    expect(publishReports).toHaveBeenCalled();
    expect(saveConfig).toHaveBeenCalledWith({ lastPostedAt: expect.any(Number) });
  });

  it('refuses when there is nowhere to post', async () => {
    loadConfig.mockReturnValue(config({ channelId: null }));
    const fake = interaction({ subcommand: 'post' });

    await command.execute(fake);

    expect(said(fake)).toContain('No channel is set');
    expect(publishReports).not.toHaveBeenCalled();
  });

  it('asks for a guild first when none are tracked', async () => {
    loadConfig.mockReturnValue(config({ guilds: [] }));
    const fake = interaction({ subcommand: 'post' });

    await command.execute(fake);

    expect(said(fake)).toContain('/report track');
    expect(buildAllReports).not.toHaveBeenCalled();
  });

  it('still posts, excluding nothing, when its own deferred reply cannot be fetched', async () => {
    const fake = interaction({ subcommand: 'post' });
    fake.fetchReply.mockRejectedValue(new Error('gone'));

    await command.execute(fake);

    expect(publishReports).toHaveBeenCalledWith(
      fake.client,
      expect.anything(),
      expect.objectContaining({ excludeMessageId: null })
    );
  });

  it('shows what failed alongside what posted', async () => {
    buildAllReports.mockResolvedValue({
      reports: [{ key: 'eu:apex', guild: APEX, embed: { fake: true } }],
      failures: [{ guild: APEX, error: new Error('boom') }]
    });

    const fake = interaction({ subcommand: 'post' });
    await command.execute(fake);

    expect(said(fake)).toContain('failed');
    expect(payloadOf(fake).embeds).toHaveLength(1);
  });
});

describe('/report excel', () => {
  function excelInteraction(overrides = {}) {
    return interaction({
      subcommand: 'excel',
      options: {},
      ...overrides
    });
  }

  it('builds the workbook from a preview, without resetting the week', async () => {
    const fake = excelInteraction();
    fake.client.users = { cache: new Map() };

    await command.execute(fake);

    expect(buildAllReports).toHaveBeenCalledWith(expect.objectContaining({ persist: false }));
    expect(saveConfig).not.toHaveBeenCalled();
    expect(buildReportWorkbookBuffer).toHaveBeenCalled();
  });

  it('attaches the workbook as an .xlsx file', async () => {
    const fake = excelInteraction();
    fake.client.users = { cache: new Map() };

    await command.execute(fake);

    const payload = payloadOf(fake);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].name).toMatch(/\.xlsx$/);
  });

  it('includes each guild\'s stored history', async () => {
    loadReportHistory.mockReturnValue([{ capturedAt: 1, members: 5 }]);
    const fake = excelInteraction();
    fake.client.users = { cache: new Map() };

    await command.execute(fake);

    expect(buildReportWorkbookBuffer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ histories: expect.any(Map) })
    );
    const [, { histories }] = buildReportWorkbookBuffer.mock.calls[0];
    expect(histories.get('eu:apex')).toEqual([{ capturedAt: 1, members: 5 }]);
  });

  it('asks for a guild first when none are tracked', async () => {
    loadConfig.mockReturnValue(config({ guilds: [] }));
    const fake = excelInteraction();
    fake.client.users = { cache: new Map() };

    await command.execute(fake);

    expect(said(fake)).toContain('/report track');
    expect(buildAllReports).not.toHaveBeenCalled();
  });

  it('shows what failed alongside the attachment', async () => {
    buildAllReports.mockResolvedValue({
      reports: [{ key: 'eu:apex', guild: APEX, embed: { fake: true }, killTally: [] }],
      failures: [{ guild: APEX, error: new Error('boom') }]
    });

    const fake = excelInteraction();
    fake.client.users = { cache: new Map() };

    await command.execute(fake);

    expect(payloadOf(fake).embeds).toHaveLength(1);
    expect(payloadOf(fake).files).toHaveLength(1);
  });

  it('says plainly when nothing could be built, with no failures to show', async () => {
    buildAllReports.mockResolvedValue({ reports: [], failures: [] });
    const fake = excelInteraction();
    fake.client.users = { cache: new Map() };

    await command.execute(fake);

    expect(said(fake)).toContain('No report could be built');
    expect(payloadOf(fake).embeds).toHaveLength(0);
    expect(buildReportWorkbookBuffer).not.toHaveBeenCalled();
  });

  it('shows the failures when every guild failed and nothing could be built', async () => {
    buildAllReports.mockResolvedValue({
      reports: [],
      failures: [{ guild: APEX, error: new Error('boom') }]
    });
    const fake = excelInteraction();
    fake.client.users = { cache: new Map() };

    await command.execute(fake);

    expect(payloadOf(fake).embeds).toHaveLength(1);
  });

  it('resolves a Discord tag for a linked character, and falls back to no tag otherwise', async () => {
    const fake = excelInteraction();
    fake.client.users = { cache: new Map([['user-9', { tag: 'Judy#0001' }]]) };

    await command.execute(fake);

    const [, { resolveTag }] = buildReportWorkbookBuffer.mock.calls[0];
    expect(resolveTag('user-9')).toBe('Judy#0001');
    expect(resolveTag('user-unknown')).toBeNull();
  });
});

describe('/report configure', () => {
  it('sets the default channel', async () => {
    const fake = interaction({
      subcommand: 'channel',
      subcommandGroup: 'configure',
      options: { channel: { id: 'channel-7' } }
    });

    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ channelId: 'channel-7' });
  });

  it('sets the day and hour, and says they are UTC', async () => {
    const fake = interaction({
      subcommand: 'schedule',
      subcommandGroup: 'configure',
      options: { day: 3, hour: 20 }
    });

    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ dayOfWeek: 3, hour: 20 });
    expect(said(fake)).toContain('UTC');
  });

  it('sets the hour alone, leaving frequency and day untouched', async () => {
    const fake = interaction({
      subcommand: 'schedule',
      subcommandGroup: 'configure',
      options: { hour: 20 }
    });

    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ hour: 20 });
  });

  it('also sets the frequency when one is given', async () => {
    const fake = interaction({
      subcommand: 'schedule',
      subcommandGroup: 'configure',
      options: { hour: 20, frequency: 'weekly', day: 3 }
    });

    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ frequency: 'weekly', hour: 20, dayOfWeek: 3 });
  });

  it('turns clearing previous reports on', async () => {
    const fake = interaction({
      subcommand: 'clear-channel',
      subcommandGroup: 'configure',
      options: { value: true }
    });

    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ clearChannel: true });
    expect(said(fake)).toContain('deleted');
  });

  it('turns clearing previous reports off', async () => {
    const fake = interaction({
      subcommand: 'clear-channel',
      subcommandGroup: 'configure',
      options: { value: false }
    });

    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ clearChannel: false });
    expect(said(fake)).toContain('left in place');
  });

  it('arms the next slot when switching on, rather than firing immediately', async () => {
    const fake = interaction({
      subcommand: 'enabled',
      subcommandGroup: 'configure',
      options: { value: true }
    });

    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ enabled: true, lastPostedAt: expect.any(Number) });
  });

  it('refuses to switch on with no guilds tracked', async () => {
    loadConfig.mockReturnValue(config({ guilds: [] }));
    const fake = interaction({
      subcommand: 'enabled',
      subcommandGroup: 'configure',
      options: { value: true }
    });

    await command.execute(fake);

    expect(said(fake)).toContain('Track at least one guild');
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('refuses to switch on with no channel', async () => {
    loadConfig.mockReturnValue(config({ channelId: null }));
    const fake = interaction({
      subcommand: 'enabled',
      subcommandGroup: 'configure',
      options: { value: true }
    });

    await command.execute(fake);

    expect(said(fake)).toContain('Set a channel first');
  });

  it('switches off without any preconditions', async () => {
    const fake = interaction({
      subcommand: 'enabled',
      subcommandGroup: 'configure',
      options: { value: false }
    });

    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ enabled: false });
  });
});

describe('describeFailure', () => {
  it('names the slug tried for a missing guild, since there is no index to search', () => {
    const error = Object.assign(new BlizzardApiError('Not found.', { status: 404 }), {
      guildSlug: 'apx'
    });

    const message = command.describeFailure({ guild: APEX, error });

    expect(message).toContain('apx');
  });

  it('falls back to the error message for anything else', () => {
    expect(command.describeFailure({ guild: APEX, error: new Error('timeout') })).toContain('timeout');
  });

  it('falls back to a generic failure when the error has no message', () => {
    expect(command.describeFailure({ guild: APEX, error: {} })).toContain('lookup failed');
  });
});
