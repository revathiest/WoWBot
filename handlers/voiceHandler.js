// handlers/voiceHandler.js
// "Join to create" private voice channels. Routing only, as with the other
// handlers — the actual create/close logic lives in utils/voice/core.js.

const { readConfig } = require('../config');
const { isGuildInScope } = require('../utils/guildScope');
const { handleVoiceStateUpdate } = require('../utils/voice/core');
const store = require('../utils/voice/store');

function registerVoiceHandler(client, Events) {
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    if (!isGuildInScope(guildId, readConfig().discord.guildId)) return;

    handleVoiceStateUpdate(oldState, newState).catch(err =>
      console.error('❌ Error in voiceStateUpdate:', err.message)
    );
  });

  // A managed room can also disappear by someone deleting the channel
  // directly rather than leaving it; without this the store would keep a
  // stale entry forever.
  client.on(Events.ChannelDelete, channel => {
    if (!isGuildInScope(channel.guildId, readConfig().discord.guildId)) return;
    if (store.getActiveChannel(channel.id)) store.removeActiveChannel(channel.id);
  });
}

module.exports = { registerVoiceHandler };
