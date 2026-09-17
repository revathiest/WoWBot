// index.js
// Entry point: validates configuration, registers slash commands, and connects to Discord.

require('dotenv/config');

const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const { readConfig, validateConfig } = require('./config');
const { registerCommands, registerGuildJoinHandler } = require('./utils/commandRegistration');
const { registerInteractionHandler } = require('./handlers/interactionHandler');
const { registerMessageHandler } = require('./handlers/messageHandler');
const { loadConfig: loadSpamConfig } = require('./utils/spam/config');
const { loadConfig: loadReportConfig, DAYS } = require('./utils/reports/config');
const { startReportScheduler, nextSlotAt } = require('./utils/reports/scheduler');
const { loadConfig: loadOnboardingConfig } = require('./utils/onboarding/config');
const { startOnboardingSweeper } = require('./utils/onboarding/sweep');
const ticketStore = require('./utils/tickets/store');
const { ensureLobbyMessage } = require('./utils/tickets/core');
const { refreshAll: refreshHelpPosts } = require('./utils/help/post');
const { loadConfig: loadAuditConfig } = require('./utils/audit/config');
const { describeGuilds, guildScopeWarnings, isGuildInScope } = require('./utils/guildScope');

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
// A guild that invites the bot gets its commands immediately, rather than at the
// next restart.
registerGuildJoinHandler(client, Events);

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

  const reports = loadReportConfig();
  if (reports.enabled && reports.guilds.length > 0) {
    const when = `${DAYS[reports.dayOfWeek]} ${String(reports.hour).padStart(2, '0')}:00 UTC`;
    console.log(
      `   Weekly reports: 📊 ${reports.guilds.length} guild(s), ${when} ` +
        `(next ${new Date(nextSlotAt(reports)).toUTCString()})`
    );
  } else {
    console.log('   Weekly reports: ⚪ off — /report track, then /report configure enabled value:true');
  }

  // Started unconditionally: it is a cheap five-minute tick that does nothing
  // until reporting is switched on, so /report configure takes effect without a
  // restart.
  startReportScheduler(readyClient);

  const onboarding = loadOnboardingConfig();
  if (onboarding.enabled) {
    console.log(
      `   Onboarding sweep: 🧹 on — ${onboarding.graceDays}d grace, reminder at ` +
        `${onboarding.warnAfterDays}d${onboarding.alertChannelId ? '' : ', NO audit channel'}`
    );
  } else {
    console.log('   Onboarding sweep: ⚪ off — /autokick preview, then /autokick configure enabled value:true');
  }

  // Same reasoning as the report scheduler: a cheap tick that no-ops until the
  // feature is switched on.
  startOnboardingSweeper(readyClient);

  // The lobby panel is a real message that can be deleted, purged, or lost when
  // a channel is recreated. Re-posting it at startup means the Open Ticket
  // button is never quietly dead.
  const ticketGuilds = Object.keys(ticketStore.load().settings).filter(guildId =>
    isGuildInScope(guildId, config.discord.guildId)
  );

  if (ticketGuilds.length > 0) {
    await Promise.allSettled(ticketGuilds.map(guildId => ensureLobbyMessage(readyClient, guildId)));
    console.log(`   Tickets: 🎫 lobby ready in ${ticketGuilds.length} guild(s)`);
  } else {
    console.log('   Tickets: ⚪ not set up — /ticket set-channel channel:#support');
  }

  await registerCommands(readyClient, { config });

  // The help post is generated from the commands that just loaded, so it is
  // rebuilt AFTER registration — that is what keeps it from ever describing a
  // command the bot no longer has, or missing one it just gained.
  const helpPosts = await refreshHelpPosts(readyClient, readyClient.commands, {
    inScope: guildId => isGuildInScope(guildId, config.discord.guildId)
  });

  const published = helpPosts.filter(result => result.ok);
  console.log(
    published.length > 0
      ? `   Help post: 📖 up to date in ${published.length} guild(s)`
      : '   Help post: ⚪ not set up — /help setup channel:#help'
  );

  const audit = loadAuditConfig();
  console.log(
    audit.enabled && audit.channelId
      ? `   Audit log: 📝 on (${audit.verbosity})`
      : '   Audit log: ⚪ off — /auditlog channel, then /auditlog enabled value:true'
  );
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
