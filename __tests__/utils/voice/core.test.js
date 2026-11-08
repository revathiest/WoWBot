jest.mock('../../../utils/voice/store');
jest.mock('../../../utils/audit/log', () => ({ record: jest.fn() }));

const { PermissionFlagsBits } = require('discord.js');
const store = require('../../../utils/voice/store');
const { record } = require('../../../utils/audit/log');
const {
  buildChannelName,
  buildOverwrites,
  handleJoin,
  handleLeave,
  handleVoiceStateUpdate,
  joinedTrigger,
  OWNER_PERMISSIONS,
  BOT_PERMISSIONS
} = require('../../../utils/voice/core');

function overwrite(id, { allow = 0n, deny = 0n, type = 0 } = {}) {
  return { id, type, allow: { bitfield: allow }, deny: { bitfield: deny } };
}

function overwriteCache(entries) {
  return { values: () => entries[Symbol.iterator]() };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('buildChannelName', () => {
  it('names the room after the member', () => {
    expect(buildChannelName({ displayName: 'Judgement' })).toBe("Judgement's Channel");
  });

  it('falls back to the username when there is no display name', () => {
    expect(buildChannelName({ displayName: '', user: { username: 'judy' } })).toBe("judy's Channel");
  });

  it('truncates to Discord\'s channel name limit', () => {
    const name = buildChannelName({ displayName: 'x'.repeat(200) });
    expect(name.length).toBe(100);
  });
});

describe('buildOverwrites', () => {
  it('carries over everything the source channel already has', () => {
    const everyone = overwrite('everyone-role', { deny: 1n });
    const inheritFrom = { permissionOverwrites: { cache: overwriteCache([everyone]) } };

    const result = buildOverwrites({ inheritFrom, botId: 'bot-1', ownerId: 'u1' });

    expect(result).toContainEqual({ id: 'everyone-role', type: 0, allow: 0n, deny: 1n });
  });

  it('drops any inherited overwrite already targeting the owner or the bot', () => {
    const inheritFrom = {
      permissionOverwrites: {
        cache: overwriteCache([overwrite('u1'), overwrite('bot-1'), overwrite('role-x')])
      }
    };

    const result = buildOverwrites({ inheritFrom, botId: 'bot-1', ownerId: 'u1' });

    expect(result.map(o => o.id)).toEqual(['role-x', 'u1', 'bot-1']);
  });

  it('grants the owner full control and the bot just enough to manage it', () => {
    const result = buildOverwrites({ inheritFrom: null, botId: 'bot-1', ownerId: 'u1' });

    expect(result).toEqual([
      { id: 'u1', allow: OWNER_PERMISSIONS.bitfield },
      { id: 'bot-1', allow: BOT_PERMISSIONS.bitfield }
    ]);
    expect(OWNER_PERMISSIONS.has(PermissionFlagsBits.ManageRoles)).toBe(true);
    expect(OWNER_PERMISSIONS.has(PermissionFlagsBits.MoveMembers)).toBe(true);
  });

  it('copes with a source channel that has no overwrites at all', () => {
    expect(buildOverwrites({ inheritFrom: {}, botId: 'bot-1', ownerId: 'u1' })).toHaveLength(2);
  });
});

function fakeMember({ id = 'owner-1', displayName = 'Owner', setChannel = jest.fn() } = {}) {
  return {
    id,
    displayName,
    user: { tag: `${displayName}#0001`, username: displayName },
    voice: { setChannel }
  };
}

function fakeGuild({ id = 'g1', created, fetchResult = null } = {}) {
  return {
    id,
    client: { user: { id: 'bot-1' } },
    channels: {
      create: jest.fn(async () => created),
      fetch: jest.fn(async () => fetchResult)
    }
  };
}

describe('handleJoin', () => {
  it('creates a room, moves the member in, and records ownership', async () => {
    const setChannel = jest.fn(async () => {});
    const member = fakeMember({ id: 'u1', displayName: 'Judgement', setChannel });
    const created = { id: 'room-1', name: "Judgement's Channel" };
    const guild = fakeGuild({ created });
    member.guild = guild;

    const triggerChannel = { parent: null, parentId: null, permissionOverwrites: { cache: overwriteCache([]) } };

    const result = await handleJoin(member, triggerChannel, { triggerChannelId: 't1', categoryId: null });

    expect(guild.channels.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Judgement's Channel", parent: null })
    );
    expect(setChannel).toHaveBeenCalledWith(created);
    expect(store.addActiveChannel).toHaveBeenCalledWith('room-1', { guildId: 'g1', ownerId: 'u1' });
    expect(record).toHaveBeenCalledWith(guild.client, expect.objectContaining({ kind: 'voice', channelId: 'room-1' }));
    expect(result).toBe(created);
  });

  it('creates the room inside a configured category', async () => {
    const created = { id: 'room-1' };
    const category = { id: 'cat-1', permissionOverwrites: { cache: overwriteCache([]) } };
    const guild = fakeGuild({ created, fetchResult: category });
    const member = fakeMember();
    member.guild = guild;

    const triggerChannel = { parent: { id: 'other-cat' }, parentId: 'other-cat', permissionOverwrites: { cache: overwriteCache([]) } };

    await handleJoin(member, triggerChannel, { triggerChannelId: 't1', categoryId: 'cat-1' });

    expect(guild.channels.fetch).toHaveBeenCalledWith('cat-1');
    expect(guild.channels.create).toHaveBeenCalledWith(expect.objectContaining({ parent: 'cat-1' }));
  });

  it('uses the trigger channel\'s own category when none is configured', async () => {
    const created = { id: 'room-1' };
    const category = { id: 'trigger-cat', permissionOverwrites: { cache: overwriteCache([]) } };
    const guild = fakeGuild({ created });
    const member = fakeMember();
    member.guild = guild;

    const triggerChannel = { parent: category, parentId: 'trigger-cat', permissionOverwrites: { cache: overwriteCache([]) } };

    await handleJoin(member, triggerChannel, { triggerChannelId: 't1', categoryId: null });

    expect(guild.channels.fetch).not.toHaveBeenCalled();
    expect(guild.channels.create).toHaveBeenCalledWith(expect.objectContaining({ parent: 'trigger-cat' }));
  });

  it('warns and gives up cleanly when the channel cannot be created', async () => {
    const guild = fakeGuild();
    guild.channels.create.mockRejectedValue(new Error('missing permissions'));
    const member = fakeMember();
    member.guild = guild;

    const triggerChannel = { parent: null, parentId: null, permissionOverwrites: { cache: overwriteCache([]) } };
    const result = await handleJoin(member, triggerChannel, { triggerChannelId: 't1', categoryId: null });

    expect(result).toBeNull();
    expect(store.addActiveChannel).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('deletes the new channel and gives up if the member could not be moved in', async () => {
    const deleteFn = jest.fn(async () => {});
    const created = { id: 'room-1', delete: deleteFn };
    const guild = fakeGuild({ created });
    const setChannel = jest.fn(async () => {
      throw new Error('already disconnected');
    });
    const member = fakeMember({ setChannel });
    member.guild = guild;

    const triggerChannel = { parent: null, parentId: null, permissionOverwrites: { cache: overwriteCache([]) } };
    const result = await handleJoin(member, triggerChannel, { triggerChannelId: 't1', categoryId: null });

    expect(deleteFn).toHaveBeenCalled();
    expect(store.addActiveChannel).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe('handleLeave', () => {
  it('does nothing for a channel that is not managed', async () => {
    store.getActiveChannel.mockReturnValue(null);

    await handleLeave({ channelId: 'c1', member: { id: 'u1' } });

    expect(store.removeActiveChannel).not.toHaveBeenCalled();
  });

  it('closes the room when the owner leaves, even if others remain', async () => {
    store.getActiveChannel.mockReturnValue({ guildId: 'g1', ownerId: 'owner-1' });
    const deleteFn = jest.fn(async () => {});
    const channel = { members: { size: 2 }, delete: deleteFn };

    await handleLeave({ channelId: 'c1', member: { id: 'owner-1' }, channel, client: {} });

    expect(store.removeActiveChannel).toHaveBeenCalledWith('c1');
    expect(deleteFn).toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith({}, expect.objectContaining({ action: expect.stringContaining('owner left') }));
  });

  it('closes the room once it is empty, even if it was not the owner who just left', async () => {
    store.getActiveChannel.mockReturnValue({ guildId: 'g1', ownerId: 'owner-1' });
    const deleteFn = jest.fn(async () => {});
    const channel = { members: { size: 0 }, delete: deleteFn };

    await handleLeave({ channelId: 'c1', member: { id: 'guest-1' }, channel, client: {} });

    expect(deleteFn).toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith({}, expect.objectContaining({ action: expect.stringContaining('empty') }));
  });

  it('leaves the room alone when someone other than the owner leaves and others remain', async () => {
    store.getActiveChannel.mockReturnValue({ guildId: 'g1', ownerId: 'owner-1' });
    const deleteFn = jest.fn(async () => {});
    const channel = { members: { size: 1 }, delete: deleteFn };

    await handleLeave({ channelId: 'c1', member: { id: 'guest-1' }, channel, client: {} });

    expect(deleteFn).not.toHaveBeenCalled();
    expect(store.removeActiveChannel).not.toHaveBeenCalled();
  });

  it('still forgets the room if it is already gone', async () => {
    store.getActiveChannel.mockReturnValue({ guildId: 'g1', ownerId: 'owner-1' });

    await handleLeave({ channelId: 'c1', member: { id: 'owner-1' }, channel: null, client: {} });

    expect(store.removeActiveChannel).toHaveBeenCalledWith('c1');
  });

  it('warns but still forgets the room if deletion fails', async () => {
    store.getActiveChannel.mockReturnValue({ guildId: 'g1', ownerId: 'owner-1' });
    const channel = { members: { size: 0 }, delete: jest.fn(async () => { throw new Error('gone'); }) };

    await handleLeave({ channelId: 'c1', member: { id: 'owner-1' }, channel, client: {} });

    expect(store.removeActiveChannel).toHaveBeenCalledWith('c1');
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('joinedTrigger', () => {
  const settings = { triggerChannelId: 'trig-1' };

  it('is true for an actual move into the trigger channel', () => {
    expect(joinedTrigger({ channelId: 'elsewhere' }, { channelId: 'trig-1' }, settings)).toBe(true);
  });

  it('is false with no settings', () => {
    expect(joinedTrigger({ channelId: null }, { channelId: 'trig-1' }, null)).toBe(false);
  });

  it('is false when already sitting in the trigger channel', () => {
    expect(joinedTrigger({ channelId: 'trig-1' }, { channelId: 'trig-1' }, settings)).toBe(false);
  });

  it('is false for a move to any other channel', () => {
    expect(joinedTrigger({ channelId: 'a' }, { channelId: 'b' }, settings)).toBe(false);
  });
});

describe('handleVoiceStateUpdate', () => {
  it('ignores a guild with nothing configured', async () => {
    store.getSettings.mockReturnValue(null);

    await handleVoiceStateUpdate(
      { channelId: null, guild: { id: 'g1' } },
      { channelId: 'somewhere', guild: { id: 'g1' }, member: {} }
    );

    expect(store.addActiveChannel).not.toHaveBeenCalled();
  });

  it('cleans up the old room even when the same move joins the trigger channel', async () => {
    store.getActiveChannel.mockReturnValue({ guildId: 'g1', ownerId: 'u1' });
    store.getSettings.mockReturnValue(null); // no trigger configured; only cleanup should run

    const deleteFn = jest.fn(async () => {});
    const oldChannel = { members: { size: 0 }, delete: deleteFn };

    await handleVoiceStateUpdate(
      { channelId: 'old-room', channel: oldChannel, member: { id: 'u1' }, guild: { id: 'g1' }, client: {} },
      { channelId: 'trig-1', guild: { id: 'g1' }, member: {} }
    );

    expect(deleteFn).toHaveBeenCalled();
  });

  it('creates a room on an actual join to the configured trigger channel', async () => {
    store.getActiveChannel.mockReturnValue(null);
    store.getSettings.mockReturnValue({ triggerChannelId: 'trig-1', categoryId: null });

    const created = { id: 'room-1' };
    const guild = fakeGuild({ created });
    const setChannel = jest.fn(async () => {});
    const member = fakeMember({ id: 'u1', setChannel });
    member.guild = guild;

    const triggerChannel = { parent: null, parentId: null, permissionOverwrites: { cache: overwriteCache([]) } };

    await handleVoiceStateUpdate(
      { channelId: null, guild: { id: 'g1' } },
      { channelId: 'trig-1', channel: triggerChannel, member, guild: { id: 'g1' } }
    );

    expect(guild.channels.create).toHaveBeenCalled();
    expect(setChannel).toHaveBeenCalledWith(created);
  });
});
