jest.mock('../../utils/reports/config', () => ({
  ...jest.requireActual('../../utils/reports/config'),
  loadConfig: jest.fn(),
  saveConfig: jest.fn(),
  trackGuild: jest.fn(),
  untrackGuild: jest.fn()
}));
jest.mock('../../utils/reports/scheduler');
jest.mock('../../utils/reports/history');

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
const { BlizzardApiError } = require('../../utils/blizzard/client');
const command = require('../../commands/wow/report');
const { createInteraction } = require('../helpers/interaction');

const APEX = { name: 'Apex', realm: 'Nightslayer', region: 'us', game: 'anniversary', channelId: null };

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
  buildAllReports.mockResolvedValue({ reports: [{ embed: { fake: true } }], failures: [] });
  publishReports.mockResolvedValue(['channel-1']);
  nextSlotAt.mockReturnValue(1_800_000_000_000);
  loadSnapshot.mockReturnValue({ capturedAt: 1 });
});

describe('command shape', () => {
  it('is named /report and declares Manage Server', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('report');
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
  });

  it('exposes the subcommands the workflow needs', () => {
    const names = command.data.toJSON().options.map(option => option.name);
    expect(names).toEqual(expect.arrayContaining(['status', 'now', 'post', 'track', 'untrack', 'configure']));
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
    loadConfig.mockReturnValue(config({ channelId: null }));

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
});

describe('/report track', () => {
  it('tracks a guild with the realm, region, and game resolved', async () => {
    const fake = interaction({ subcommand: 'track', options: { guild: 'Apex', realm: 'Nightslayer' } });
    await command.execute(fake);

    expect(trackGuild).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Apex', realm: 'Nightslayer', region: 'us' })
    );
    expect(said(fake)).toContain('Now reporting on');
  });

  it('falls back to the configured home realm', async () => {
    // jest.setup.js pins BLIZZARD_REALM to Testrealm.
    const fake = interaction({ subcommand: 'track', options: { guild: 'Apex' } });
    await command.execute(fake);

    expect(trackGuild).toHaveBeenCalledWith(expect.objectContaining({ realm: 'Testrealm' }));
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
});

describe('/report untrack', () => {
  it('removes the guild and discards its history', async () => {
    const fake = interaction({ subcommand: 'untrack', options: { guild: 'Apex' } });
    await command.execute(fake);

    expect(deleteSnapshot).toHaveBeenCalled();
    expect(said(fake)).toContain('No longer reporting');
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
  it('names both slugs for a missing guild, since there is no index to search', () => {
    const error = Object.assign(new BlizzardApiError('Not found.', { status: 404 }), {
      realmSlug: 'nightslayer',
      guildSlug: 'apx'
    });

    const message = command.describeFailure({ guild: APEX, error });

    expect(message).toContain('apx');
    expect(message).toContain('nightslayer');
  });

  it('falls back to the error message for anything else', () => {
    expect(command.describeFailure({ guild: APEX, error: new Error('timeout') })).toContain('timeout');
  });
});
