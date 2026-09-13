jest.mock('../../utils/spam/config', () => {
  const actual = jest.requireActual('../../utils/spam/config');
  return { ...actual, loadConfig: jest.fn(), saveConfig: jest.fn() };
});

const { loadConfig, saveConfig, normalizeConfig } = require('../../utils/spam/config');
const command = require('../../commands/admin/spam');
const { createInteraction, field } = require('../helpers/interaction');

const config = (overrides = {}) => normalizeConfig(overrides);

beforeEach(() => {
  jest.clearAllMocks();
  loadConfig.mockReturnValue(config());
  saveConfig.mockImplementation(changes => normalizeConfig({ ...config(), ...changes }));
});

/** The command replies rather than defers, so read reply() not editReply(). */
function replyPayload(interaction) {
  return interaction.reply.mock.calls[interaction.reply.mock.calls.length - 1][0];
}

function replyEmbed(interaction) {
  return replyPayload(interaction).embeds[0].toJSON();
}

describe('/spam definition', () => {
  it('is named spam and hidden from non-admins by default', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('spam');
    // ManageGuild; the exact bitfield is stringified by the builder.
    expect(json.default_member_permissions).toBeTruthy();
  });

  it('offers status, test, and a configure group', () => {
    const json = command.data.toJSON();
    const names = json.options.map(option => option.name);

    expect(names).toEqual(expect.arrayContaining(['status', 'test', 'configure']));
  });
});

describe('permission enforcement', () => {
  it('refuses a member without Manage Server', async () => {
    const interaction = createInteraction({
      commandName: 'spam',
      subcommand: 'status',
      permissions: false
    });

    await command.execute(interaction);

    expect(replyPayload(interaction).content).toContain('Manage Server');
    expect(loadConfig).not.toHaveBeenCalled();
  });
});

describe('/spam status', () => {
  it('shows the tier table and flags a missing alert channel', async () => {
    const interaction = createInteraction({ commandName: 'spam', subcommand: 'status' });

    await command.execute(interaction);

    const embed = replyEmbed(interaction);
    expect(embed.title).toContain('Disabled');
    expect(embed.description).toContain('New');
    expect(embed.description).toContain('Established');
    expect(field(embed, 'Alert Channel').value).toContain('not set');
    expect(embed.footer.text).toContain('Moderators');
  });

  it('reflects an enabled configuration', async () => {
    loadConfig.mockReturnValue(config({ enabled: true, alertChannelId: 'c9' }));
    const interaction = createInteraction({ commandName: 'spam', subcommand: 'status' });

    await command.execute(interaction);

    const embed = replyEmbed(interaction);
    expect(embed.title).toContain('Enabled');
    expect(field(embed, 'Alert Channel').value).toBe('<#c9>');
  });
});

describe('/spam test', () => {
  it('reports the flags a scam message would raise', async () => {
    const interaction = createInteraction({
      commandName: 'spam',
      subcommand: 'test',
      options: { text: 'free nitro at discord.gg/abc' }
    });

    await command.execute(interaction);

    const embed = replyEmbed(interaction);
    expect(embed.title).toContain('red flag');
    expect(field(embed, 'Flags').value).toContain('Nitro/gift card scam');
    expect(field(embed, 'Outcome').value).toContain('New account');
    expect(embed.footer.text).toContain('nobody was actioned');
  });

  it('reports a clean message', async () => {
    const interaction = createInteraction({
      commandName: 'spam',
      subcommand: 'test',
      options: { text: 'the enemy did an airdrop on our position' }
    });

    await command.execute(interaction);

    expect(replyEmbed(interaction).title).toContain('No red flags');
  });

  it('never writes config or state', async () => {
    const interaction = createInteraction({
      commandName: 'spam',
      subcommand: 'test',
      options: { text: 'free nitro' }
    });

    await command.execute(interaction);

    expect(saveConfig).not.toHaveBeenCalled();
  });
});

describe('/spam configure', () => {
  const configure = (subcommand, options) =>
    createInteraction({
      commandName: 'spam',
      subcommandGroup: 'configure',
      subcommand,
      options
    });

  it('enables and disables', async () => {
    await command.execute(configure('enabled', { value: true }));
    expect(saveConfig).toHaveBeenCalledWith({ enabled: true });

    await command.execute(configure('enabled', { value: false }));
    expect(saveConfig).toHaveBeenCalledWith({ enabled: false });
  });

  it('sets the alert channel', async () => {
    await command.execute(configure('alert-channel', { channel: { id: 'c9' } }));

    expect(saveConfig).toHaveBeenCalledWith({ alertChannelId: 'c9' });
  });

  it('converts the rate-limit window from seconds to milliseconds', async () => {
    await command.execute(configure('rate-limit', { count: 8, seconds: 10 }));

    expect(saveConfig).toHaveBeenCalledWith({ rateLimit: { count: 8, windowMs: 10000 } });
  });

  it('sets the action, converting minutes to milliseconds', async () => {
    await command.execute(configure('action', { type: 'timeout', minutes: 30 }));

    expect(saveConfig).toHaveBeenCalledWith({ action: 'timeout', timeoutMs: 1800000 });
  });

  it('leaves the duration alone when none is given', async () => {
    await command.execute(configure('action', { type: 'ban' }));

    expect(saveConfig).toHaveBeenCalledWith({ action: 'ban' });
  });

  it('sets the secondary action separately', async () => {
    await command.execute(configure('secondary-action', { type: 'timeout', minutes: 60 }));

    expect(saveConfig).toHaveBeenCalledWith({
      secondaryAction: 'timeout',
      secondaryTimeoutMs: 3600000
    });
  });

  it('updates only the thresholds supplied', async () => {
    await command.execute(configure('thresholds', { signals: 3 }));

    expect(saveConfig).toHaveBeenCalledWith({ signalThreshold: 3 });
  });

  it('rejects a thresholds call with nothing to change', async () => {
    const interaction = configure('thresholds', {});

    await command.execute(interaction);

    expect(saveConfig).not.toHaveBeenCalled();
    expect(replyPayload(interaction).content).toContain('at least one value');
  });

  it('adds and removes an exempt role', async () => {
    await command.execute(configure('exempt-role', { mode: 'add', role: { id: 'r1' } }));
    expect(saveConfig).toHaveBeenCalledWith({ exemptRoleIds: ['r1'] });

    loadConfig.mockReturnValue(config({ exemptRoleIds: ['r1'] }));
    await command.execute(configure('exempt-role', { mode: 'remove', role: { id: 'r1' } }));
    expect(saveConfig).toHaveBeenLastCalledWith({ exemptRoleIds: [] });
  });

  it('adds an exempt channel', async () => {
    await command.execute(configure('exempt-channel', { mode: 'add', channel: { id: 'c1' } }));

    expect(saveConfig).toHaveBeenCalledWith({ exemptChannelIds: ['c1'] });
  });

  it('reports an unknown setting instead of throwing', () => {
    expect(command.applyConfigure('nonsense', createInteraction({}))).toContain('Unknown setting');
  });

  it('replies ephemerally', async () => {
    const interaction = configure('enabled', { value: true });

    await command.execute(interaction);

    expect(replyPayload(interaction).flags).toBeDefined();
  });
});
