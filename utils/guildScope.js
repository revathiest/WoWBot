// utils/guildScope.js
// Startup visibility into which guilds this process is actually serving.
//
// GUILD_ID is the single most misread setting in this bot. It scopes where slash
// commands are REGISTERED. It does not scope which guilds the bot connects to:
// a logged-in token receives events from every guild the bot was invited to.
//
// That misreading caused a long outage — a second deployment with a different
// GUILD_ID was still in this guild, still received every interaction, and raced
// the local instance for the right to answer. Whichever lost got a confusing
// "Unknown interaction" error. Printing the guild list makes it obvious.

/** One line per guild, for the startup banner. */
function describeGuilds(guilds) {
  if (guilds.length === 0) return 'none (the bot has not been invited anywhere)';
  return guilds.map(guild => `${guild.name} [${guild.id}]`).join(', ');
}

/**
 * Warns when the bot is in guilds beyond the configured one.
 *
 * @returns {string[]} warning lines; empty when the scope is unambiguous
 */
function guildScopeWarnings(guilds, guildId) {
  if (!guildId || guilds.length === 0) return [];

  const configured = guilds.find(guild => guild.id === guildId);
  const others = guilds.filter(guild => guild.id !== guildId);
  const warnings = [];

  if (!configured) {
    warnings.push(
      `GUILD_ID ${guildId} is not a guild this bot has joined, so its commands will not appear there.`
    );
  }

  if (others.length > 0) {
    warnings.push(
      `This bot also receives events from ${others.length} other guild(s): ${describeGuilds(others)}.`,
      'GUILD_ID only scopes command REGISTRATION — it does NOT stop this process ' +
        'from handling interactions and messages in those guilds.',
      'If another deployment shares this token, both will race to answer every ' +
        'interaction. Use a separate Discord application per environment.'
    );
  }

  return warnings;
}

module.exports = { describeGuilds, guildScopeWarnings };
