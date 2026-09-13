// utils/commandRegistration.js
// Loads every command module under commands/ and publishes the slash commands to Discord.

const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
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
 * Loads commands onto `client.commands` and pushes their definitions to Discord.
 * Registers to a single guild when GUILD_ID is set (updates are instant, which is
 * what you want in development) and globally otherwise.
 */
async function registerCommands(client, options = {}) {
  const config = options.config ?? readConfig();
  const commandMap = options.commandMap ?? loadCommandsRecursively();

  client.commands = commandMap;

  const definitions = [...commandMap.values()].map(command => command.data.toJSON());
  const names = definitions.map(definition => definition.name).join(', ') || 'none';

  const { applicationId, guildId, token } = config.discord;

  if (!applicationId) {
    console.warn('⚠️  APPLICATION_ID is not set; skipping slash command registration.');
    return commandMap;
  }

  const rest = options.rest ?? new REST({ version: '10' }).setToken(token);

  const route = guildId
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId);

  const scope = guildId ? `guild ${guildId}` : 'globally';

  try {
    await rest.put(route, { body: definitions });
    console.log(`✅ Registered ${definitions.length} command(s) ${scope}: ${names}`);
  } catch (err) {
    console.error(`❌ Failed to register slash commands ${scope}:`, err);
  }

  return commandMap;
}

module.exports = {
  COMMANDS_DIR,
  loadCommandsRecursively,
  registerCommands
};
