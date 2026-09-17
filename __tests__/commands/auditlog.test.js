jest.mock('../../utils/audit/config', () => ({
  ...jest.requireActual('../../utils/audit/config'),
  loadConfig: jest.fn(),
  saveConfig: jest.fn()
}));
jest.mock('../../utils/audit/log');
jest.mock('../../utils/channelLock');

const { PermissionFlagsBits } = require('discord.js');

const { DEFAULTS, loadConfig, saveConfig, normalizeConfig } = require('../../utils/audit/config');
const { record } = require('../../utils/audit/log');
const { lockChannel } = require('../../utils/channelLock');
const command = require('../../commands/admin/auditlog');
const { createInteraction } = require('../helpers/interaction');

function config(overrides = {}) {
  return normalizeConfig({ ...DEFAULTS, ...overrides });
}

function interaction({ subcommand, options = {}, permissions = true } = {}) {
  return createInteraction({ commandName: 'auditlog', subcommand, options, permissions });
}

function payloadOf(fake) {
  const call = fake.editReply.mock.calls.at(-1) ?? fake.reply.mock.calls.at(-1);
  return call[0];
}

function said(fake) {
  const payload = payloadOf(fake);
  return typeof payload === 'string' ? payload : payload.content;
}

beforeEach(() => {
  jest.clearAllMocks();
  loadConfig.mockReturnValue(config());
  saveConfig.mockImplementation(changes => config(changes));
  lockChannel.mockResolvedValue({ ok: true, grantedRoles: ['mod'], clearedRoles: [], warnings: [] });
});

describe('command shape', () => {
  it('is named /auditlog and declares Manage Server', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('auditlog');
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
  });
});

describe('permissions', () => {
  it('refuses a member without Manage Server', async () => {
    const fake = interaction({ subcommand: 'status', permissions: false });
    await command.execute(fake);

    expect(said(fake)).toContain('Manage Server');
  });
});

describe('/auditlog channel', () => {
  it('hides the channel rather than merely locking it', async () => {
    // The log names who ran what; it is not for the whole server to read.
    const fake = interaction({ subcommand: 'channel', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(lockChannel).toHaveBeenCalledWith(
      { id: 'c1' },
      expect.objectContaining({ visibility: 'admins' })
    );
    expect(said(fake)).toContain('hidden');
  });

  it('names the roles that can still see it', async () => {
    const fake = interaction({ subcommand: 'channel', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(said(fake)).toContain('<@&mod>');
  });

  it('stores the channel', async () => {
    const fake = interaction({ subcommand: 'channel', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ channelId: 'c1' });
  });

  it('warns that the log is readable when the lock failed', async () => {
    lockChannel.mockResolvedValue({ ok: false, reason: 'missing permissions' });

    const fake = interaction({ subcommand: 'channel', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(said(fake)).toContain('could **not** be locked');
  });

  it('surfaces a warning about nobody being able to see it', async () => {
    lockChannel.mockResolvedValue({
      ok: true,
      grantedRoles: [],
      clearedRoles: [],
      warnings: ['no role has Manage Server, so only members with Administrator can see the channel']
    });

    const fake = interaction({ subcommand: 'channel', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(said(fake)).toContain('Administrator');
  });

  it('defers, because editing permissions is several round trips', async () => {
    const fake = interaction({ subcommand: 'channel', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(fake.deferReply).toHaveBeenCalled();
  });
});

describe('/auditlog enabled', () => {
  it('refuses to switch on without a channel', async () => {
    const fake = interaction({ subcommand: 'enabled', options: { value: true } });
    await command.execute(fake);

    expect(said(fake)).toContain('Set a channel first');
  });

  it('switches on once a channel is set', async () => {
    loadConfig.mockReturnValue(config({ channelId: 'c1' }));

    const fake = interaction({ subcommand: 'enabled', options: { value: true } });
    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ enabled: true });
  });

  it('switches off with no preconditions', async () => {
    const fake = interaction({ subcommand: 'enabled', options: { value: false } });
    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ enabled: false });
  });
});

describe('/auditlog verbosity', () => {
  it('sets the level and explains what it means', async () => {
    const fake = interaction({ subcommand: 'verbosity', options: { level: 'admin' } });
    await command.execute(fake);

    expect(saveConfig).toHaveBeenCalledWith({ verbosity: 'admin' });
    expect(said(fake)).toContain('/character');
  });
});

describe('/auditlog status', () => {
  it('says it is off by default', () => {
    expect(command.buildStatusEmbed(config()).toJSON().description).toContain('Off');
  });

  it('names the channel when on', () => {
    const embed = command.buildStatusEmbed(config({ enabled: true, channelId: 'c1' })).toJSON();
    expect(embed.description).toContain('<#c1>');
  });

  it('points at the feature-specific alert channels, so they are not confused', () => {
    const fields = command.buildStatusEmbed(config()).toJSON().fields;
    expect(fields.find(f => f.name === 'Note').value).toContain('alert channels');
  });
});

describe('self-logging', () => {
  it('records its own configuration changes', async () => {
    const fake = interaction({ subcommand: 'verbosity', options: { level: 'all' } });
    await command.execute(fake);

    expect(record).toHaveBeenCalledWith(fake.client, expect.objectContaining({ kind: 'config' }));
  });
});
