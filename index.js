// index.js
// Entry point: validates configuration, registers slash commands, and connects to Discord.

require('dotenv/config');

const { Client, Events, GatewayIntentBits } = require('discord.js');
const { readConfig, validateConfig } = require('./config');
const { registerCommands } = require('./utils/commandRegistration');
const { registerInteractionHandler } = require('./handlers/interactionHandler');

const config = readConfig();
const problems = validateConfig(config);

if (problems.length > 0) {
  console.error('❌ Cannot start — the environment is incomplete:');
  problems.forEach(problem => console.error(`   • ${problem}`));
  console.error('   Copy .env.example to .env and fill in the blanks.');
  process.exit(1);
}

// Slash commands only, so the bot needs nothing beyond the Guilds intent.
// No privileged intents are required.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

registerInteractionHandler(client, Events);

client.once(Events.ClientReady, async readyClient => {
  console.log(`🟢 Logged in as ${readyClient.user.tag}`);
  console.log(`   Default region: ${config.blizzard.region.toUpperCase()} • locale: ${config.blizzard.locale}`);

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
