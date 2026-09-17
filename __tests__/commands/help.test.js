jest.mock('../../utils/help/store');
jest.mock('../../utils/help/post');
jest.mock('../../utils/channelLock');

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const store = require('../../utils/help/store');
const { setupHelpChannel } = require('../../utils/help/post');
const { isLocked, unlockChannel } = require('../../utils/channelLock');
const command = require('../../commands/help');
const { createInteraction } = require('../helpers/interaction');

function fakeCommand(name, category = 'WoW') {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription('Does a thing.'),
    help: 'Does a thing.',
    category
  };
}

const COMMANDS = new Map([
  ['token', fakeCommand('token')],
  ['spam', fakeCommand('spam', 'Admin')]
]);

function interaction({ subcommand, options = {}, permissions = true } = {}) {
  const fake = createInteraction({
    commandName: 'help',
    subcommand,
    options,
    permissions,
    client: { commands: COMMANDS }
  });

  fake.guild = { id: 'test-guild', name: 'Test Guild', channels: { fetch: jest.fn(async () => null) } };
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
  store.get.mockReturnValue(null);
  setupHelpChannel.mockResolvedValue({
    lock: { ok: true, clearedRoles: [], warnings: [] },
    post: { ok: true, mode: 'published', messageIds: ['m1', 'm2', 'm3'] }
  });
  unlockChannel.mockResolvedValue({ ok: true });
  isLocked.mockReturnValue(true);
});

describe('command shape', () => {
  it('is open to everyone, because /help show is for everyone', () => {
    // The admin subcommands check Manage Server in code instead.
    expect(command.data.toJSON().default_member_permissions).toBeUndefined();
  });

  it('offers show, setup, unlock and status', () => {
    expect(command.data.toJSON().options.map(o => o.name)).toEqual([
      'show',
      'setup',
      'unlock',
      'status'
    ]);
  });

  it('has no refresh command, because the post checks itself on every boot', () => {
    expect(command.data.toJSON().options.map(o => o.name)).not.toContain('refresh');
  });
});

describe('/help show', () => {
  it('lists the commands for anyone, without needing permissions', async () => {
    const fake = interaction({ subcommand: 'show', permissions: false });
    await command.execute(fake);

    expect(payloadOf(fake).embeds.length).toBeGreaterThan(1);
  });

  it('explains one command when asked', async () => {
    const fake = interaction({ subcommand: 'show', options: { command: 'token' } });
    await command.execute(fake);

    expect(payloadOf(fake).embeds[0].toJSON().title).toBe('/token');
  });

  it('tolerates a leading slash', async () => {
    const fake = interaction({ subcommand: 'show', options: { command: '/token' } });
    await command.execute(fake);

    expect(payloadOf(fake).embeds[0].toJSON().title).toBe('/token');
  });

  it('says so for a command that does not exist', async () => {
    const fake = interaction({ subcommand: 'show', options: { command: 'nonsense' } });
    await command.execute(fake);

    expect(said(fake)).toContain('no `/nonsense` command');
  });
});

describe('permissions', () => {
  it.each(['setup', 'unlock'])('refuses /help %s without Manage Server', async subcommand => {
    const fake = interaction({ subcommand, permissions: false, options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(said(fake)).toContain('Manage Server');
    expect(setupHelpChannel).not.toHaveBeenCalled();
  });

  it('allows status for anyone', async () => {
    const fake = interaction({ subcommand: 'status', permissions: false });
    await command.execute(fake);

    expect(payloadOf(fake).embeds).toBeDefined();
  });
});

describe('/help setup', () => {
  it('locks the channel and publishes', async () => {
    const fake = interaction({ subcommand: 'setup', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(setupHelpChannel).toHaveBeenCalled();
    expect(said(fake)).toContain('read-only');
    expect(said(fake)).toContain('3 posts');
  });

  it('always states that administrators bypass the lock', async () => {
    // Never promise a stronger guarantee than Discord actually gives.
    const fake = interaction({ subcommand: 'setup', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(said(fake)).toContain('Administrator');
  });

  it('names roles whose posting rights were revoked', async () => {
    setupHelpChannel.mockResolvedValue({
      lock: { ok: true, clearedRoles: ['r1'], warnings: [] },
      post: { ok: true, messageIds: ['m1'] }
    });

    const fake = interaction({ subcommand: 'setup', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(said(fake)).toContain('<@&r1>');
  });

  it('says the channel is still writable when the lock failed', async () => {
    setupHelpChannel.mockResolvedValue({
      lock: { ok: false, reason: 'missing permissions' },
      post: { ok: true, messageIds: ['m1'] }
    });

    const fake = interaction({ subcommand: 'setup', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(said(fake)).toContain('could **not** be locked');
  });

  it('reports a post that could not be published', async () => {
    setupHelpChannel.mockResolvedValue({
      lock: { ok: true, clearedRoles: [], warnings: [] },
      post: { ok: false, reason: 'no permission' }
    });

    const fake = interaction({ subcommand: 'setup', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(said(fake)).toContain('could not be published');
  });
});

describe('/help unlock', () => {
  it('hands the channel back', async () => {
    const fake = interaction({ subcommand: 'unlock', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(unlockChannel).toHaveBeenCalled();
    expect(said(fake)).toContain('normal permissions');
  });

  it('reports a failure', async () => {
    unlockChannel.mockResolvedValue({ ok: false, reason: 'missing permissions' });

    const fake = interaction({ subcommand: 'unlock', options: { channel: { id: 'c1' } } });
    await command.execute(fake);

    expect(said(fake)).toContain('Could not unlock');
  });
});

describe('/help status', () => {
  it('says it is not set up yet', () => {
    expect(command.buildStatusEmbed('test-guild', null).toJSON().description).toContain('Not set up');
  });

  it('counts the published posts', () => {
    store.get.mockReturnValue({ channelId: 'c1', messageIds: ['m1', 'm2'] });

    const fields = command.buildStatusEmbed('test-guild', null).toJSON().fields;
    expect(fields.find(f => f.name === 'Posts').value).toBe('2 messages');
  });

  it('flags a channel that is no longer locked', () => {
    store.get.mockReturnValue({ channelId: 'c1', messageIds: ['m1'] });
    isLocked.mockReturnValue(false);

    const fields = command.buildStatusEmbed('test-guild', { id: 'c1' }).toJSON().fields;
    expect(fields.find(f => f.name === 'Channel').value).toContain('writable');
  });
});
