jest.mock('../../utils/nicknames/config', () => ({
  ...jest.requireActual('../../utils/nicknames/config'),
  loadConfig: jest.fn()
}));
jest.mock('../../utils/nicknames/sync');

const { loadConfig } = require('../../utils/nicknames/config');
const { syncMember } = require('../../utils/nicknames/sync');
const { handleGuildMemberAdd, registerMemberHandler } = require('../../handlers/memberHandler');

function member(guildId = 'test-guild') {
  return { id: 'u1', guild: { id: guildId } };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  loadConfig.mockReturnValue({ enabled: true, lastSyncAt: null });
  syncMember.mockResolvedValue({ action: 'rename', to: 'Butud' });
});

afterEach(() => jest.restoreAllMocks());

describe('handleGuildMemberAdd', () => {
  it('restores the nickname a rejoining member lost', async () => {
    // Discord discards a nickname when somebody leaves.
    await handleGuildMemberAdd(member());
    expect(syncMember).toHaveBeenCalled();
  });

  it('does nothing while nickname syncing is off', async () => {
    loadConfig.mockReturnValue({ enabled: false });

    expect(await handleGuildMemberAdd(member())).toBeNull();
    expect(syncMember).not.toHaveBeenCalled();
  });

  it('ignores a guild this instance does not serve', async () => {
    const previous = process.env.GUILD_ID;
    process.env.GUILD_ID = 'pinned';

    try {
      expect(await handleGuildMemberAdd(member('somewhere-else'))).toBeNull();
      expect(syncMember).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.GUILD_ID;
      else process.env.GUILD_ID = previous;
    }
  });

  it('tolerates a member with no guild', async () => {
    expect(await handleGuildMemberAdd(null)).toBeNull();
  });
});

describe('registerMemberHandler', () => {
  it('wires the join event', () => {
    const client = { on: jest.fn() };
    registerMemberHandler(client, { GuildMemberAdd: 'guildMemberAdd' });

    expect(client.on).toHaveBeenCalledWith('guildMemberAdd', expect.any(Function));
  });

  it('logs a failure instead of letting it escape as an unhandled rejection', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    syncMember.mockRejectedValue(new Error('boom'));

    const client = { on: jest.fn() };
    registerMemberHandler(client, { GuildMemberAdd: 'guildMemberAdd' });

    // The listener deliberately returns nothing — Discord does not await it.
    const listener = client.on.mock.calls[0][1];
    expect(listener(member())).toBeUndefined();

    await Promise.resolve();
    await Promise.resolve();

    expect(console.error).toHaveBeenCalled();
  });
});
