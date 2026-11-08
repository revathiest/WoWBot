jest.mock('../../utils/voice/core', () => ({ handleVoiceStateUpdate: jest.fn() }));
jest.mock('../../utils/voice/store', () => ({
  getActiveChannel: jest.fn(),
  removeActiveChannel: jest.fn()
}));

const { handleVoiceStateUpdate } = require('../../utils/voice/core');
const store = require('../../utils/voice/store');
const { registerVoiceHandler } = require('../../handlers/voiceHandler');

const Events = { VoiceStateUpdate: 'voiceStateUpdate', ChannelDelete: 'channelDelete' };

function listenersFor(event) {
  const client = { on: jest.fn() };
  registerVoiceHandler(client, Events);
  return client.on.mock.calls.find(call => call[0] === event)[1];
}

beforeEach(() => {
  jest.clearAllMocks();
  handleVoiceStateUpdate.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.GUILD_ID;
});

describe('registerVoiceHandler', () => {
  it('wires both events', () => {
    const client = { on: jest.fn() };
    registerVoiceHandler(client, Events);

    expect(client.on).toHaveBeenCalledWith('voiceStateUpdate', expect.any(Function));
    expect(client.on).toHaveBeenCalledWith('channelDelete', expect.any(Function));
  });

  describe('voiceStateUpdate', () => {
    it('delegates to the core handler', () => {
      const listener = listenersFor('voiceStateUpdate');
      const oldState = { guild: { id: 'test-guild' } };
      const newState = { guild: { id: 'test-guild' } };

      listener(oldState, newState);

      expect(handleVoiceStateUpdate).toHaveBeenCalledWith(oldState, newState);
    });

    it('ignores a guild this instance does not serve', () => {
      process.env.GUILD_ID = 'pinned';
      const listener = listenersFor('voiceStateUpdate');

      listener({ guild: { id: 'elsewhere' } }, { guild: { id: 'elsewhere' } });

      expect(handleVoiceStateUpdate).not.toHaveBeenCalled();
    });

    it('logs a failure instead of letting it escape as an unhandled rejection', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      handleVoiceStateUpdate.mockRejectedValue(new Error('boom'));

      const listener = listenersFor('voiceStateUpdate');
      listener({ guild: { id: 'test-guild' } }, { guild: { id: 'test-guild' } });

      await Promise.resolve();
      await Promise.resolve();

      expect(console.error).toHaveBeenCalled();
      console.error.mockRestore();
    });
  });

  describe('channelDelete', () => {
    it('forgets a managed room deleted directly rather than left', () => {
      store.getActiveChannel.mockReturnValue({ guildId: 'test-guild', ownerId: 'u1' });
      const listener = listenersFor('channelDelete');

      listener({ id: 'room-1', guildId: 'test-guild' });

      expect(store.removeActiveChannel).toHaveBeenCalledWith('room-1');
    });

    it('does nothing for a channel that was never managed', () => {
      store.getActiveChannel.mockReturnValue(null);
      const listener = listenersFor('channelDelete');

      listener({ id: 'other', guildId: 'test-guild' });

      expect(store.removeActiveChannel).not.toHaveBeenCalled();
    });

    it('ignores a guild this instance does not serve', () => {
      process.env.GUILD_ID = 'pinned';
      store.getActiveChannel.mockReturnValue({ guildId: 'elsewhere', ownerId: 'u1' });
      const listener = listenersFor('channelDelete');

      listener({ id: 'room-1', guildId: 'elsewhere' });

      expect(store.getActiveChannel).not.toHaveBeenCalled();
    });
  });
});
