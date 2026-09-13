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

/**
 * Whether this process should act on an event from `guildId`.
 *
 * When GUILD_ID is set the instance is dedicated to that guild and ignores
 * everything else, so several deployments can share one bot token without
 * racing each other. With GUILD_ID blank the instance serves every guild.
 *
 * DM events (no guild) are never in scope — this bot is guild-only.
 */
function isGuildInScope(guildId, configuredGuildId) {
  if (!guildId) return false;
  if (!configuredGuildId) return true;
  return guildId === configuredGuildId;
}

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
      `Ignoring events from ${others.length} other guild(s): ${describeGuilds(others)}.`,
      'Another instance must serve those, or they get no response at all.'
    );
  }

  return warnings;
}

module.exports = { describeGuilds, guildScopeWarnings, isGuildInScope };
