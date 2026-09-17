// handlers/memberHandler.js
// Member arrivals. Routing only, as with the other handlers.
//
// Discord discards a nickname when somebody leaves the server, so a member who
// rejoins comes back under their account name. Without this, their nickname
// would stay wrong until the next bulk sync.

const { loadConfig } = require('../utils/nicknames/config');
const { syncMember } = require('../utils/nicknames/sync');
const { isGuildInScope } = require('../utils/guildScope');
const { readConfig } = require('../config');

async function handleGuildMemberAdd(member) {
  if (!member?.guild) return null;

  // Same pin as everywhere else: a dev instance must not rename people in the
  // production server.
  if (!isGuildInScope(member.guild.id, readConfig().discord.guildId)) return null;

  if (!loadConfig().enabled) return null;

  const plan = await syncMember(member.guild, member);

  if (plan?.action === 'rename') {
    console.log(`🏷️  Restored ${member.id}'s nickname to ${plan.to} on rejoin.`);
  }

  return plan;
}

/** Wires the listener. `Events` is injected, matching the other handlers. */
function registerMemberHandler(client, Events) {
  client.on(Events.GuildMemberAdd, member => {
    handleGuildMemberAdd(member).catch(err =>
      console.error('❌ Error in guildMemberAdd:', err.message)
    );
  });
}

module.exports = { handleGuildMemberAdd, registerMemberHandler };
