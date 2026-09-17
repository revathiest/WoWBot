jest.mock('../../utils/tickets/store');
jest.mock('../../utils/tickets/core');
jest.mock('../../utils/channelLock');

const { PermissionFlagsBits } = require('discord.js');

const store = require('../../utils/tickets/store');
const { ensureLobbyMessage } = require('../../utils/tickets/core');
const { isLocked, lockChannel } = require('../../utils/channelLock');
const command = require('../../commands/admin/ticket');
const { createInteraction } = require('../helpers/interaction');

function interaction({ subcommand, subcommandGroup = null, options = {}, permissions = true } = {}) {
  const fake = createInteraction({
    commandName: 'ticket',
    subcommand,
    subcommandGroup,
    options,
    permissions
  });

  fake.guild = {
    id: 'test-guild',
    channels: { fetch: jest.fn(async () => null) }
  };

  return fake;
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
  store.getSettings.mockReturnValue(null);
  store.getRoles.mockReturnValue([]);
  store.load.mockReturnValue({ open: {}, closed: [], settings: {}, roles: {}, nextId: 1 });
  store.history.mockReturnValue([]);
  store.addRole.mockReturnValue({ added: true });
  store.removeRole.mockReturnValue({ removed: true });
  ensureLobbyMessage.mockResolvedValue({ id: 'msg1' });
  lockChannel.mockResolvedValue({ ok: true, clearedRoles: [], warnings: [] });
  isLocked.mockReturnValue(true);
});

describe('command shape', () => {
  it('is named /ticket and declares Manage Server', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('ticket');
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
  });

  it('covers setup, roles, status and history', () => {
    const names = command.data.toJSON().options.map(option => option.name);

    expect(names).toEqual(
      expect.arrayContaining(['set-channel', 'set-archive', 'lobby-policing', 'status', 'history', 'roles'])
    );
  });
});

describe('permissions', () => {
  it('refuses a member without Manage Server', async () => {
    const fake = interaction({ subcommand: 'status', permissions: false });
    await command.execute(fake);

    expect(said(fake)).toContain('Manage Server');
  });
});

describe('/ticket set-channel', () => {
  it('saves the lobby and posts the panel', async () => {
    const fake = interaction({ subcommand: 'set-channel', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(store.setSettings).toHaveBeenCalledWith(
      'test-guild',
      expect.objectContaining({ channelId: 'c1', messageId: null })
    );
    expect(ensureLobbyMessage).toHaveBeenCalled();
    expect(said(fake)).toContain('panel posted');
  });

  it('locks the lobby so the panel cannot be pushed out of view', async () => {
    const fake = interaction({ subcommand: 'set-channel', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(lockChannel).toHaveBeenCalledWith({ id: 'c1' }, expect.objectContaining({ botId: 'bot-1' }));
    expect(said(fake)).toContain('read-only');
  });

  it('says so when the channel could not be locked, rather than implying it was', async () => {
    lockChannel.mockResolvedValue({ ok: false, reason: 'missing permissions' });
    const fake = interaction({ subcommand: 'set-channel', options: { channel: { id: 'c1' } } });

    await command.execute(fake);

    expect(said(fake)).toContain('could **not** be locked');
  });

  it('names roles whose channel-specific posting rights were revoked', async () => {
    lockChannel.mockResolvedValue({ ok: true, clearedRoles: ['r9'], warnings: [] });
    const fake = interaction({ subcommand: 'set-channel', options: { channel: { id: 'c1' } } });

    await command.execute(fake);

    expect(said(fake)).toContain('<@&r9>');
  });

  it('accepts an archive category at the same time', async () => {
    const fake = interaction({
      subcommand: 'set-channel',
      options: { channel: { id: 'c1' }, archive_category: { id: 'a1' } }
    });

    await command.execute(fake);

    expect(store.setSettings).toHaveBeenCalledWith(
      'test-guild',
      expect.objectContaining({ archiveCategoryId: 'a1' })
    );
  });

  it('removes the old panel when the lobby moves', async () => {
    // Two live panels is worse than none — the old button still works.
    const oldMessage = { delete: jest.fn(async () => {}) };
    const oldChannel = { messages: { fetch: jest.fn(async () => oldMessage) } };

    store.getSettings.mockReturnValue({ channelId: 'old', messageId: 'oldmsg' });

    const fake = interaction({ subcommand: 'set-channel', options: { channel: { id: 'new' } } });
    fake.guild.channels.fetch.mockResolvedValue(oldChannel);

    await command.execute(fake);

    expect(oldMessage.delete).toHaveBeenCalled();
  });

  it('names the permissions to check when the panel cannot be posted', async () => {
    ensureLobbyMessage.mockResolvedValue(null);
    const fake = interaction({ subcommand: 'set-channel', options: { channel: { id: 'c1' } } });

    await command.execute(fake);

    expect(said(fake)).toContain('Send Messages');
  });
});

describe('/ticket set-archive', () => {
  it('requires the lobby to exist first', async () => {
    const fake = interaction({ subcommand: 'set-archive', options: { category: { id: 'a1' } } });
    await command.execute(fake);

    expect(store.setSettings).not.toHaveBeenCalled();
    expect(said(fake)).toContain('Set the lobby first');
  });

  it('sets the archive category', async () => {
    store.getSettings.mockReturnValue({ channelId: 'c1' });
    const fake = interaction({ subcommand: 'set-archive', options: { category: { id: 'a1' } } });

    await command.execute(fake);

    expect(store.setSettings).toHaveBeenCalledWith('test-guild', { archiveCategoryId: 'a1' });
  });
});

describe('/ticket lobby-policing', () => {
  it('turns policing on', async () => {
    const fake = interaction({ subcommand: 'lobby-policing', options: { value: true } });
    await command.execute(fake);

    expect(store.setSettings).toHaveBeenCalledWith('test-guild', { policeLobby: true });
    expect(said(fake)).toContain('deleted');
  });

  it('turns policing off', async () => {
    const fake = interaction({ subcommand: 'lobby-policing', options: { value: false } });
    await command.execute(fake);

    expect(store.setSettings).toHaveBeenCalledWith('test-guild', { policeLobby: false });
    expect(said(fake)).toContain('left alone');
  });
});

describe('/ticket roles', () => {
  it('adds a role and explains what it gains', async () => {
    const fake = interaction({
      subcommand: 'add',
      subcommandGroup: 'roles',
      options: { role: { id: 'r1' } }
    });

    await command.execute(fake);

    expect(store.addRole).toHaveBeenCalledWith('test-guild', 'r1');
    expect(said(fake)).toContain('claim and close');
  });

  it('reports a role that was already added', async () => {
    store.addRole.mockReturnValue({ added: false });
    const fake = interaction({
      subcommand: 'add',
      subcommandGroup: 'roles',
      options: { role: { id: 'r1' } }
    });

    await command.execute(fake);

    expect(said(fake)).toContain('already');
  });

  it('removes a role', async () => {
    const fake = interaction({
      subcommand: 'remove',
      subcommandGroup: 'roles',
      options: { role: { id: 'r1' } }
    });

    await command.execute(fake);

    expect(store.removeRole).toHaveBeenCalledWith('test-guild', 'r1');
  });

  it('lists the configured roles', async () => {
    store.getRoles.mockReturnValue(['r1', 'r2']);
    const fake = interaction({ subcommand: 'list', subcommandGroup: 'roles' });

    await command.execute(fake);

    expect(said(fake)).toContain('<@&r1>');
  });

  it('explains the fallback when no roles are set', async () => {
    const fake = interaction({ subcommand: 'list', subcommandGroup: 'roles' });
    await command.execute(fake);

    expect(said(fake)).toContain('Manage Channels');
  });
});

describe('/ticket status', () => {
  it('says it is not set up yet', () => {
    expect(command.buildStatusEmbed('test-guild').toJSON().description).toContain('Not set up');
  });

  it('shows the lobby, archive and policing state once configured', () => {
    store.getSettings.mockReturnValue({
      channelId: 'c1',
      archiveCategoryId: 'a1',
      policeLobby: false
    });

    const fields = command.buildStatusEmbed('test-guild').toJSON().fields;

    expect(fields.find(f => f.name === 'Lobby').value).toBe('<#c1>');
    expect(fields.find(f => f.name === 'Archive').value).toBe('<#a1>');
    expect(fields.find(f => f.name === 'Lobby policing').value).toBe('off');
  });

  it('counts open tickets for this guild only', () => {
    store.getSettings.mockReturnValue({ channelId: 'c1' });
    store.load.mockReturnValue({
      open: {
        c1: { id: 1, guildId: 'test-guild' },
        c2: { id: 2, guildId: 'elsewhere' }
      },
      closed: [],
      settings: {},
      roles: {},
      nextId: 3
    });

    const fields = command.buildStatusEmbed('test-guild').toJSON().fields;

    expect(fields.find(f => f.name === 'Open tickets').value).toBe('1');
  });
});

describe('/ticket history', () => {
  it('shows recent tickets for the whole server', async () => {
    store.history.mockReturnValue([{ id: 1, userId: 'u1', description: 'help', createdAt: 1000 }]);
    const fake = interaction({ subcommand: 'history' });

    await command.execute(fake);

    expect(store.history).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
    expect(payloadOf(fake).embeds[0].toJSON().description).toContain('`#1`');
  });

  it('narrows to one member', async () => {
    const fake = interaction({ subcommand: 'history', options: { user: { id: 'u9' } } });
    await command.execute(fake);

    expect(store.history).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u9' }));
  });
});
