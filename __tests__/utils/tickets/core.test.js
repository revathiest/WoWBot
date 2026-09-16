jest.mock('../../../utils/tickets/store');

const { PermissionFlagsBits } = require('discord.js');

const store = require('../../../utils/tickets/store');
const {
  buildChannelOverwrites,
  createTicket,
  ensureLobbyMessage,
  handleComponent,
  handleCreateButton,
  handleLobbyMessage,
  isModerator
} = require('../../../utils/tickets/core');

const GUILD_ID = 'g1';

/** A member with the given permissions and roles. */
function member({ id = 'u1', permissions = [], roleIds = [], displayName = 'Tester' } = {}) {
  return {
    id,
    displayName,
    user: { id, username: displayName },
    permissions: { has: flag => permissions.includes(flag) },
    roles: { cache: new Map(roleIds.map(roleId => [roleId, {}])) }
  };
}

function fakeChannel(id = 'c1', overrides = {}) {
  return {
    id,
    parent: { id: 'cat1' },
    isTextBased: () => true,
    toString: () => `<#${id}>`,
    send: jest.fn(async () => ({ id: 'msg1' })),
    messages: { fetch: jest.fn(async () => ({ id: 'msg1', edit: jest.fn(async () => {}), delete: jest.fn(async () => {}) })) },
    permissionOverwrites: { edit: jest.fn(async () => {}) },
    setParent: jest.fn(async () => {}),
    ...overrides
  };
}

function fakeGuild({ channels = {}, ticketChannel = fakeChannel('t1') } = {}) {
  return {
    id: GUILD_ID,
    name: 'Test Guild',
    roles: { everyone: { id: GUILD_ID } },
    members: { cache: new Map() },
    channels: {
      fetch: jest.fn(async id => channels[id] ?? null),
      create: jest.fn(async () => ticketChannel)
    }
  };
}

/** A modal-submit interaction for the create flow. */
function modalInteraction({ guild, description = 'I need help with something' } = {}) {
  return {
    guildId: GUILD_ID,
    guild,
    channelId: 'lobby',
    user: { id: 'u1', username: 'Tester' },
    member: member(),
    client: { user: { id: 'bot1' } },
    customId: 'ticket:modal:create',
    fields: { getTextInputValue: jest.fn(() => description) },
    isButton: () => false,
    isModalSubmit: () => true,
    reply: jest.fn(async () => {}),
    deferReply: jest.fn(async () => {}),
    editReply: jest.fn(async () => {}),
    showModal: jest.fn(async () => {})
  };
}

function buttonInteraction({ customId, guild, actor = member(), channel = fakeChannel() } = {}) {
  return {
    guildId: GUILD_ID,
    guild,
    channel,
    channelId: channel.id,
    customId,
    user: { id: actor.id, username: actor.displayName },
    member: actor,
    client: { user: { id: 'bot1' } },
    isButton: () => true,
    isModalSubmit: () => false,
    reply: jest.fn(async () => {}),
    showModal: jest.fn(async () => {}),
    deferReply: jest.fn(async () => {}),
    editReply: jest.fn(async () => {})
  };
}

function said(interaction) {
  const call = interaction.editReply.mock.calls.at(-1) ?? interaction.reply.mock.calls.at(-1);
  const payload = call[0];
  return typeof payload === 'string' ? payload : payload.content;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  store.MAX_OPEN_PER_USER = 3;
  store.getSettings.mockReturnValue({
    channelId: 'lobby',
    messageId: 'lobbymsg',
    archiveCategoryId: null,
    policeLobby: true
  });
  store.getRoles.mockReturnValue([]);
  store.openCountFor.mockReturnValue(0);
  store.reserveId.mockReturnValue(7);
  store.openTicket.mockImplementation(ticket => ticket);
  store.updateTicket.mockImplementation((_channelId, changes) => changes);
  store.getOpenById.mockReturnValue(null);
  store.closeTicket.mockImplementation(() => null);
});

afterEach(() => jest.restoreAllMocks());

describe('isModerator', () => {
  it('always allows Manage Server, even once roles are configured', () => {
    // The system this was ported from locks admins out the moment a moderator
    // role exists, which is how a server ends up unable to close its own tickets.
    store.getRoles.mockReturnValue(['r1']);

    expect(isModerator(GUILD_ID, member({ permissions: [PermissionFlagsBits.ManageGuild] }))).toBe(true);
  });

  it('allows a configured moderator role', () => {
    store.getRoles.mockReturnValue(['r1']);
    expect(isModerator(GUILD_ID, member({ roleIds: ['r1'] }))).toBe(true);
  });

  it('refuses somebody with neither', () => {
    store.getRoles.mockReturnValue(['r1']);
    expect(isModerator(GUILD_ID, member({ roleIds: ['other'] }))).toBe(false);
  });

  it('falls back to Manage Channels while no roles are configured', () => {
    store.getRoles.mockReturnValue([]);

    expect(isModerator(GUILD_ID, member({ permissions: [PermissionFlagsBits.ManageChannels] }))).toBe(true);
    expect(isModerator(GUILD_ID, member())).toBe(false);
  });

  it('refuses a missing member', () => {
    expect(isModerator(GUILD_ID, null)).toBe(false);
  });
});

describe('buildChannelOverwrites', () => {
  it('hides the channel from everyone by default', () => {
    const guild = fakeGuild();
    const [everyone] = buildChannelOverwrites({ guild, botId: 'bot1', userId: 'u1', roleIds: [] });

    expect(everyone.id).toBe(GUILD_ID);
    expect(everyone.deny).toBeDefined();
  });

  it('grants the opener and the bot access', () => {
    const guild = fakeGuild();
    const overwrites = buildChannelOverwrites({ guild, botId: 'bot1', userId: 'u1', roleIds: [] });

    expect(overwrites.map(o => o.id)).toEqual([GUILD_ID, 'u1', 'bot1']);
  });

  it('grants every moderator role access', () => {
    const guild = fakeGuild();
    const overwrites = buildChannelOverwrites({ guild, botId: 'bot1', userId: 'u1', roleIds: ['r1', 'r2'] });

    expect(overwrites.map(o => o.id)).toContain('r1');
    expect(overwrites.map(o => o.id)).toContain('r2');
  });
});

describe('handleCreateButton', () => {
  it('shows the form when pressed in the lobby', async () => {
    const interaction = buttonInteraction({
      customId: 'ticket:create',
      channel: fakeChannel('lobby')
    });

    await handleCreateButton(interaction);

    expect(interaction.showModal).toHaveBeenCalled();
  });

  it('refuses a button pressed outside the lobby', async () => {
    const interaction = buttonInteraction({
      customId: 'ticket:create',
      channel: fakeChannel('elsewhere')
    });

    await handleCreateButton(interaction);

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(said(interaction)).toContain('only be opened from the ticket channel');
  });

  it('refuses when the system is not configured', async () => {
    store.getSettings.mockReturnValue(null);
    const interaction = buttonInteraction({ customId: 'ticket:create' });

    await handleCreateButton(interaction);

    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('caps how many tickets one person can have open', async () => {
    // Each open ticket is a real channel.
    store.openCountFor.mockReturnValue(3);
    const interaction = buttonInteraction({
      customId: 'ticket:create',
      channel: fakeChannel('lobby')
    });

    await handleCreateButton(interaction);

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(said(interaction)).toContain('already have 3 open tickets');
  });
});

describe('createTicket', () => {
  it('creates a private channel named after the opener and the ticket', async () => {
    const guild = fakeGuild({ channels: { lobby: fakeChannel('lobby') } });
    const interaction = modalInteraction({ guild });

    await createTicket(interaction);

    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ticket-tester-7' })
    );
  });

  it('records the ticket only after the channel exists', async () => {
    // The original inserts first, so a failed creation leaves a ticket that
    // exists in the database and nowhere else.
    const guild = fakeGuild({ channels: { lobby: fakeChannel('lobby') } });
    guild.channels.create.mockRejectedValue(new Error('Missing Permissions'));

    const interaction = modalInteraction({ guild });
    await createTicket(interaction);

    expect(store.openTicket).not.toHaveBeenCalled();
    expect(said(interaction)).toContain('Manage Channels');
  });

  it('puts the ticket in the lobby\'s category', async () => {
    const guild = fakeGuild({ channels: { lobby: fakeChannel('lobby') } });

    await createTicket(modalInteraction({ guild }));

    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ parent: { id: 'cat1' } })
    );
  });

  it('still works when the lobby is not inside a category', async () => {
    // The original refuses outright in this case.
    const guild = fakeGuild({ channels: { lobby: fakeChannel('lobby', { parent: null }) } });

    await createTicket(modalInteraction({ guild }));

    expect(guild.channels.create).toHaveBeenCalledWith(expect.objectContaining({ parent: null }));
  });

  it('pings the opener and the moderator roles', async () => {
    store.getRoles.mockReturnValue(['r1']);
    const ticketChannel = fakeChannel('t1');
    const guild = fakeGuild({ channels: { lobby: fakeChannel('lobby') }, ticketChannel });

    await createTicket(modalInteraction({ guild }));

    const payload = ticketChannel.send.mock.calls[0][0];

    expect(payload.content).toBe('<@u1> <@&r1>');
    expect(payload.allowedMentions).toEqual({ users: ['u1'], roles: ['r1'] });
  });

  it('stores the description and control message id', async () => {
    const guild = fakeGuild({ channels: { lobby: fakeChannel('lobby') } });

    await createTicket(modalInteraction({ guild, description: 'Broken quest' }));

    expect(store.openTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 7,
        userId: 'u1',
        channelId: 't1',
        controlMessageId: 'msg1',
        description: 'Broken quest'
      })
    );
  });

  it('refuses when the system is not configured', async () => {
    store.getSettings.mockReturnValue(null);
    const interaction = modalInteraction({ guild: fakeGuild() });

    await createTicket(interaction);

    expect(store.reserveId).not.toHaveBeenCalled();
  });
});

describe('claiming', () => {
  const TICKET = { id: 7, guildId: GUILD_ID, userId: 'u1', channelId: 'c1', controlMessageId: 'msg1', claimedBy: null };

  it('lets a moderator claim an open ticket', async () => {
    store.getOpenById.mockReturnValue(TICKET);
    store.getRoles.mockReturnValue(['r1']);

    const interaction = buttonInteraction({
      customId: 'ticket:claim:7',
      actor: member({ id: 'mod1', roleIds: ['r1'] }),
      guild: fakeGuild()
    });

    await handleComponent(interaction);

    expect(store.updateTicket).toHaveBeenCalledWith('c1', { claimedBy: 'mod1' });
    expect(said(interaction)).toContain('claimed by <@mod1>');
  });

  it('refuses a non-moderator', async () => {
    store.getOpenById.mockReturnValue(TICKET);
    store.getRoles.mockReturnValue(['r1']);

    const interaction = buttonInteraction({
      customId: 'ticket:claim:7',
      actor: member({ id: 'rando' }),
      guild: fakeGuild()
    });

    await handleComponent(interaction);

    expect(store.updateTicket).not.toHaveBeenCalled();
    expect(said(interaction)).toContain('Only ticket moderators');
  });

  it('refuses a second claim and names the holder', async () => {
    store.getOpenById.mockReturnValue({ ...TICKET, claimedBy: 'mod1' });
    store.getRoles.mockReturnValue([]);

    const interaction = buttonInteraction({
      customId: 'ticket:claim:7',
      actor: member({ id: 'mod2', permissions: [PermissionFlagsBits.ManageChannels] }),
      guild: fakeGuild()
    });

    await handleComponent(interaction);

    expect(store.updateTicket).not.toHaveBeenCalled();
    expect(said(interaction)).toContain('<@mod1>');
  });

  it('reports a ticket that no longer exists', async () => {
    store.getOpenById.mockReturnValue(null);

    const interaction = buttonInteraction({ customId: 'ticket:claim:7', guild: fakeGuild() });
    await handleComponent(interaction);

    expect(said(interaction)).toContain('already closed');
  });
});

describe('closing', () => {
  const TICKET = { id: 7, guildId: GUILD_ID, userId: 'u1', channelId: 'c1', controlMessageId: 'msg1', claimedBy: 'mod1' };

  function closeInteraction(overrides = {}) {
    return buttonInteraction({
      customId: 'ticket:close:7',
      actor: member({ id: 'mod1', permissions: [PermissionFlagsBits.ManageGuild] }),
      guild: fakeGuild(),
      ...overrides
    });
  }

  beforeEach(() => {
    store.getOpenById.mockReturnValue(TICKET);
    store.closeTicket.mockReturnValue({ ...TICKET, closedBy: 'mod1', closedAt: 2000 });
  });

  it('moves the ticket into history', async () => {
    const interaction = closeInteraction();
    await handleComponent(interaction);

    expect(store.closeTicket).toHaveBeenCalledWith('c1', { closedBy: 'mod1' });
  });

  it('revokes the opener\'s access', async () => {
    const channel = fakeChannel('c1');
    const interaction = closeInteraction({ channel });

    await handleComponent(interaction);

    expect(channel.permissionOverwrites.edit).toHaveBeenCalledWith('u1', {
      ViewChannel: false,
      SendMessages: false
    });
  });

  it('archives the channel when a category is configured', async () => {
    store.getSettings.mockReturnValue({ channelId: 'lobby', archiveCategoryId: 'archive1' });
    const channel = fakeChannel('c1');

    await handleComponent(closeInteraction({ channel }));

    expect(channel.setParent).toHaveBeenCalledWith('archive1', expect.objectContaining({ lockPermissions: false }));
  });

  it('leaves the channel where it is when no archive is set', async () => {
    const channel = fakeChannel('c1');
    await handleComponent(closeInteraction({ channel }));

    expect(channel.setParent).not.toHaveBeenCalled();
  });

  it('answers before rearranging the channel, so the interaction cannot expire', async () => {
    const channel = fakeChannel('c1');
    const interaction = closeInteraction({ channel });

    await handleComponent(interaction);

    expect(interaction.reply.mock.invocationCallOrder[0]).toBeLessThan(
      channel.permissionOverwrites.edit.mock.invocationCallOrder[0]
    );
  });

  it('refuses a non-moderator', async () => {
    store.getRoles.mockReturnValue(['r1']);
    const interaction = closeInteraction({ actor: member({ id: 'rando' }) });

    await handleComponent(interaction);

    expect(store.closeTicket).not.toHaveBeenCalled();
  });

  it('mutes moderator roles but leaves them able to read the record', async () => {
    store.getRoles.mockReturnValue(['r1']);
    const channel = fakeChannel('c1');

    await handleComponent(closeInteraction({ channel }));

    expect(channel.permissionOverwrites.edit).toHaveBeenCalledWith('r1', { SendMessages: false });
  });

  it('survives a permission edit that Discord rejects', async () => {
    const channel = fakeChannel('c1');
    channel.permissionOverwrites.edit.mockRejectedValue(new Error('Missing Permissions'));

    await expect(handleComponent(closeInteraction({ channel }))).resolves.toBe(true);
  });

  it('warns but still closes when the channel cannot be archived', async () => {
    // The ticket is closed in the store either way; failing to move a channel
    // must not leave it open forever.
    store.getSettings.mockReturnValue({ channelId: 'lobby', archiveCategoryId: 'archive1' });
    const channel = fakeChannel('c1');
    channel.setParent.mockRejectedValue(new Error('Missing Permissions'));

    await handleComponent(closeInteraction({ channel }));

    expect(store.closeTicket).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('carries on when the control message has been deleted', async () => {
    const channel = fakeChannel('c1');
    channel.messages.fetch.mockRejectedValue(new Error('Unknown Message'));

    await expect(handleComponent(closeInteraction({ channel }))).resolves.toBe(true);
    expect(store.closeTicket).toHaveBeenCalled();
  });

  it('keeps the claimer on the button when they are still in the server', async () => {
    const guild = fakeGuild();
    guild.members.cache.set('mod1', { displayName: 'Alex' });

    const edit = jest.fn(async () => {});
    const channel = fakeChannel('c1');
    channel.messages.fetch.mockResolvedValue({ edit });

    await handleComponent(closeInteraction({ channel, guild }));

    const buttons = edit.mock.calls[0][0].components[0].toJSON().components;
    expect(buttons[0].label).toBe('Claimed by Alex');
  });
});

describe('handleComponent routing', () => {
  it('ignores components belonging to something else', async () => {
    const interaction = buttonInteraction({ customId: 'poll:vote:1', guild: fakeGuild() });
    expect(await handleComponent(interaction)).toBe(false);
  });

  it('routes the create modal', async () => {
    const guild = fakeGuild({ channels: { lobby: fakeChannel('lobby') } });
    const interaction = modalInteraction({ guild });

    expect(await handleComponent(interaction)).toBe(true);
    expect(guild.channels.create).toHaveBeenCalled();
  });

  it('rejects a malformed ticket id rather than acting on NaN', async () => {
    const interaction = buttonInteraction({ customId: 'ticket:claim:abc', guild: fakeGuild() });

    expect(await handleComponent(interaction)).toBe(true);
    expect(said(interaction)).toContain('malformed');
  });

  it('ignores a modal that is not the create form', async () => {
    const interaction = modalInteraction({ guild: fakeGuild() });
    interaction.customId = 'ticket:modal:something-else';

    expect(await handleComponent(interaction)).toBe(false);
  });

  it('ignores an interaction that is neither a button nor a modal', async () => {
    const interaction = buttonInteraction({ customId: 'ticket:create', guild: fakeGuild() });
    interaction.isButton = () => false;

    expect(await handleComponent(interaction)).toBe(false);
  });

  it('ignores an unknown ticket action', async () => {
    const interaction = buttonInteraction({ customId: 'ticket:explode:7', guild: fakeGuild() });

    expect(await handleComponent(interaction)).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('handleLobbyMessage', () => {
  function lobbyMessage({ channelId = 'lobby', bot = false, permissions = [] } = {}) {
    return {
      guild: { id: GUILD_ID },
      channel: { id: channelId, send: jest.fn(async () => ({ delete: jest.fn() })) },
      channelId,
      author: { id: 'u1', bot, username: 'Tester', send: jest.fn(async () => {}) },
      member: member({ permissions }),
      delete: jest.fn(async () => {})
    };
  }

  it('deletes a stray message and DMs the sender', async () => {
    const message = lobbyMessage();

    expect(await handleLobbyMessage(message)).toBe(true);
    expect(message.delete).toHaveBeenCalled();
    expect(message.author.send).toHaveBeenCalled();
  });

  it('falls back to a channel notice when DMs are closed', async () => {
    const message = lobbyMessage();
    message.author.send.mockRejectedValue(new Error('Cannot send messages to this user'));

    await handleLobbyMessage(message);

    expect(message.channel.send).toHaveBeenCalled();
  });

  it('leaves other channels alone', async () => {
    const message = lobbyMessage({ channelId: 'general' });

    expect(await handleLobbyMessage(message)).toBe(false);
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('leaves moderators alone', async () => {
    const message = lobbyMessage({ permissions: [PermissionFlagsBits.ManageChannels] });

    expect(await handleLobbyMessage(message)).toBe(false);
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('ignores bots, including its own panel', async () => {
    const message = lobbyMessage({ bot: true });

    expect(await handleLobbyMessage(message)).toBe(false);
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('does nothing when policing is switched off', async () => {
    store.getSettings.mockReturnValue({ channelId: 'lobby', policeLobby: false });
    const message = lobbyMessage();

    expect(await handleLobbyMessage(message)).toBe(false);
    expect(message.delete).not.toHaveBeenCalled();
  });

  it('does nothing when tickets are not set up', async () => {
    store.getSettings.mockReturnValue(null);
    expect(await handleLobbyMessage(lobbyMessage())).toBe(false);
  });
});

describe('ensureLobbyMessage', () => {
  function clientWith(guild) {
    return { guilds: { fetch: jest.fn(async () => guild) } };
  }

  it('edits the existing panel when it is still there', async () => {
    const edit = jest.fn(async () => {});
    const channel = fakeChannel('lobby');
    channel.messages.fetch.mockResolvedValue({ id: 'lobbymsg', edit });
    const guild = fakeGuild({ channels: { lobby: channel } });

    await ensureLobbyMessage(clientWith(guild), GUILD_ID);

    expect(edit).toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('posts a new panel when the old one is gone', async () => {
    // Panels get deleted by channel purges; the button must not stay dead.
    const channel = fakeChannel('lobby');
    channel.messages.fetch.mockRejectedValue(new Error('Unknown Message'));
    const guild = fakeGuild({ channels: { lobby: channel } });

    await ensureLobbyMessage(clientWith(guild), GUILD_ID);

    expect(channel.send).toHaveBeenCalled();
    expect(store.setSettings).toHaveBeenCalledWith(GUILD_ID, { messageId: 'msg1' });
  });

  it('does nothing for a guild with no ticket setup', async () => {
    store.getSettings.mockReturnValue(null);
    expect(await ensureLobbyMessage(clientWith(fakeGuild()), GUILD_ID)).toBeNull();
  });

  it('warns rather than throwing when the guild is unreachable', async () => {
    const client = { guilds: { fetch: jest.fn(async () => { throw new Error('Unknown Guild'); }) } };

    expect(await ensureLobbyMessage(client, GUILD_ID)).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('warns when the lobby channel has been deleted', async () => {
    const guild = fakeGuild({ channels: {} });

    expect(await ensureLobbyMessage(clientWith(guild), GUILD_ID)).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });
});
