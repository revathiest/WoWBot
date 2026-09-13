// index.js
// Entry point: validates configuration, registers slash commands, and connects to Discord.

require('dotenv/config');

const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const { readConfig, validateConfig } = require('./config');
const { registerCommands } = require('./utils/commandRegistration');
const { registerInteractionHandler } = require('./handlers/interactionHandler');
const { registerMessageHandler } = require('./handlers/messageHandler');
const { loadConfig: loadSpamConfig } = require('./utils/spam/config');
const { describeGuilds, guildScopeWarnings } = require('./utils/guildScope');

const config = readConfig();
const problems = validateConfig(config);

if (problems.length > 0) {
  console.error('❌ Cannot start — the environment is incomplete:');
  problems.forEach(problem => console.error(`   • ${problem}`));
  console.error('   Copy .env.example to .env and fill in the blanks.');
  process.exit(1);
}

// Slash commands need only Guilds. Spam detection needs the rest, and two of
// them are PRIVILEGED: MessageContent and GuildMembers must be switched on under
// Bot -> Privileged Gateway Intents in the Discord Developer Portal, or login
// fails with a "disallowed intents" error.
//
//   GuildMessages  - receive messages at all
//   MessageContent - read what they say (privileged)
//   GuildMembers   - member join date and roles, for trust tiers (privileged)
//
// Partials let edits to messages that predate the current session still be seen.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel]
});

registerInteractionHandler(client, Events);
registerMessageHandler(client, Events);

client.once(Events.ClientReady, async readyClient => {
  console.log(`🟢 Logged in as ${readyClient.user.tag}`);
  console.log(`   Default region: ${config.blizzard.region.toUpperCase()} • locale: ${config.blizzard.locale}`);

  // Which guilds this process actually serves. A token receives events from every
  // guild it has joined, regardless of GUILD_ID, so make that visible up front.
  const guilds = [...readyClient.guilds.cache.values()];
  console.log(`   Guilds (${guilds.length}): ${describeGuilds(guilds)}`);
  guildScopeWarnings(guilds, config.discord.guildId).forEach(line => console.warn(`⚠️  ${line}`));

  const spam = loadSpamConfig();
  console.log(
    `   Spam detection: ${spam.enabled ? `🛡️  enabled (${spam.action})` : '⚪ disabled — /spam configure enabled value:true'}`
  );
  if (spam.enabled && !spam.alertChannelId) {
    console.warn('⚠️  Spam detection is on but no alert channel is set; enforcement will be silent.');
  }

  await registerCommands(readyClient, { config });
});

client.on(Events.Error, err => console.error('Discord client error:', err));

process.on('unhandledRejection', err => console.error('Unhandled promise rejection:', err));

async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down.`);
  try {
    await client.destroy();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(config.discord.token).catch(err => {
  console.error('❌ Failed to log in to Discord:', err.message);
  process.exit(1);
});

module.exports = { client };
