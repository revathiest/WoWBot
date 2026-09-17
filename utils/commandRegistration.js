// utils/commandRegistration.js
// Loads every command module under commands/ and publishes the slash commands to Discord.

const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits, REST, Routes } = require('discord.js');
const { readConfig } = require('../config');

const COMMANDS_DIR = path.join(__dirname, '..', 'commands');

/**
 * Walks a directory tree and requires every .js file, collecting modules that
 * export the usual `{ data, execute }` command shape. A file that fails to load
 * is logged and skipped so one bad command cannot stop the bot from starting.
 */
function loadCommandsRecursively(dir = COMMANDS_DIR, commandMap = new Map()) {
  if (!fs.existsSync(dir)) return commandMap;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      loadCommandsRecursively(fullPath, commandMap);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;

    try {
      const command = require(fullPath);

      if (!command?.data || typeof command.data.toJSON !== 'function') {
        throw new TypeError(`missing a 'data' builder`);
      }

      if (typeof command.execute !== 'function') {
        throw new TypeError(`missing an 'execute' function`);
      }

      commandMap.set(command.data.name, command);
    } catch (err) {
      console.warn(`⚠️  Skipped command "${entry.name}": ${err.message}`);
    }
  }

  return commandMap;
}

/**
 * Removes every globally registered command for the application.
 *
 * Guild-scoped and global commands are additive in Discord's UI, so a command
 * registered both ways shows up twice. Returns how many were removed.
 */
async function clearGlobalCommands(rest, applicationId) {
  const existing = await rest.get(Routes.applicationCommands(applicationId));

  if (!Array.isArray(existing) || existing.length === 0) return 0;

  await rest.put(Routes.applicationCommands(applicationId), { body: [] });

  return existing.length;
}

/** Pushes the command set to one guild. Returns true on success. */
async function putGuildCommands({ rest, applicationId, guildId, definitions, label }) {
  try {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: definitions });
    console.log(`✅ Registered ${definitions.length} command(s) to ${label}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to register commands to ${label}: ${err.message}`);
    return false;
  }
}

/**
 * The command definitions, built once and reused across guilds.
 *
 * When `adminOnly` is on, every definition is stamped with Manage Server
 * regardless of what the command declares for itself. That hides them from
 * ordinary members in the UI; the real check is in handlers/interactionHandler,
 * since a guild can override the permission Discord shows.
 */
function buildDefinitions(commandMap, { adminOnly = readConfig().discord.adminOnly } = {}) {
  return [...commandMap.values()].map(command => {
    const definition = command.data.toJSON();

    if (!adminOnly) return definition;

    return {
      ...definition,
      default_member_permissions: String(PermissionFlagsBits.ManageGuild)
    };
  });
}

/**
 * Registers the command set to every guild the bot is in, or to GUILD_ID alone
 * when one is configured.
 *
 * Guild commands are used rather than global ones because they appear instantly;
 * global registration can take up to an hour to propagate, which makes adding a
 * command feel broken. The cost is one API call per guild, which is negligible
 * at this scale.
 *
 * GUILD_ID is optional and rarely needed: leave it blank and the bot serves every
 * guild it joins, registering on the way in. Set it only to pin an instance to a
 * single guild.
 */
async function registerCommands(client, options = {}) {
  const config = options.config ?? readConfig();
  const commandMap = options.commandMap ?? loadCommandsRecursively();

  client.commands = commandMap;

  const definitions = buildDefinitions(commandMap);
  const names = definitions.map(definition => definition.name).join(', ') || 'none';

  const { applicationId, guildId, token } = config.discord;

  if (!applicationId) {
    console.warn('⚠️  APPLICATION_ID is not set; skipping slash command registration.');
    return commandMap;
  }

  const rest = options.rest ?? new REST({ version: '10' }).setToken(token);

  // Pinned to one guild, or every guild this bot has joined.
  const targets = guildId
    ? [{ id: guildId, name: `guild ${guildId}` }]
    : [...(client.guilds?.cache?.values() ?? [])].map(guild => ({
        id: guild.id,
        name: `${guild.name} [${guild.id}]`
      }));

  if (targets.length === 0) {
    console.warn('⚠️  The bot is not in any guild, so there is nowhere to register commands.');
    return commandMap;
  }

  console.log(`   Commands: ${names}`);

  let registered = 0;
  for (const target of targets) {
    const ok = await putGuildCommands({
      rest,
      applicationId,
      guildId: target.id,
      definitions,
      label: target.name
    });
    if (ok) registered += 1;
  }

  // Global commands would stack on top of the guild ones and show up twice. Only
  // clear them once at least one guild registration succeeded, so a total failure
  // cannot leave the application with no commands anywhere.
  if (registered > 0) {
    try {
      const removed = await clearGlobalCommands(rest, applicationId);
      if (removed > 0) {
        console.log(`🧹 Removed ${removed} global command(s) to avoid duplicates.`);
      }
    } catch (err) {
      console.warn(`⚠️  Could not clear global commands: ${err.message}`);
    }
  }

  return commandMap;
}

/**
 * Registers commands to a guild the bot has just joined, so the commands are
 * usable immediately rather than after the next restart.
 */
async function registerCommandsForGuild(client, guild, options = {}) {
  const config = options.config ?? readConfig();
  const { applicationId, guildId, token } = config.discord;

  if (!applicationId) return false;

  // A pinned instance ignores guilds it does not serve.
  if (guildId && guild.id !== guildId) {
    console.log(`↪️  Joined ${guild.name} [${guild.id}], but this instance is pinned elsewhere.`);
    return false;
  }

  const commandMap = client.commands ?? loadCommandsRecursively();
  const rest = options.rest ?? new REST({ version: '10' }).setToken(token);

  console.log(`👋 Joined ${guild.name} [${guild.id}] — registering commands.`);

  return putGuildCommands({
    rest,
    applicationId,
    guildId: guild.id,
    definitions: buildDefinitions(commandMap),
    label: `${guild.name} [${guild.id}]`
  });
}

/** Wires automatic registration when the bot is added to a guild. */
function registerGuildJoinHandler(client, Events, options = {}) {
  client.on(Events.GuildCreate, guild => {
    registerCommandsForGuild(client, guild, options).catch(err =>
      console.error(`❌ Error registering commands for a new guild: ${err.message}`)
    );
  });
}

module.exports = {
  COMMANDS_DIR,
  buildDefinitions,
  clearGlobalCommands,
  loadCommandsRecursively,
  putGuildCommands,
  registerCommands,
  registerCommandsForGuild,
  registerGuildJoinHandler
};
