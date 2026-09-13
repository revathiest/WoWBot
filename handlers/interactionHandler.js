// handlers/interactionHandler.js
// Routes chat-input interactions to their command module and keeps failures contained.

const { MessageFlags } = require('discord.js');
const { BlizzardApiError } = require('../utils/blizzard/client');
const { isGuildInScope } = require('../utils/guildScope');
const { readConfig } = require('../config');

/**
 * Turns an error into something worth showing a Discord user. Blizzard's own
 * failures get a specific message; anything else stays deliberately vague.
 */
function describeError(err) {
  if (err instanceof BlizzardApiError || err?.name === 'BlizzardApiError') {
    if (err.status === 404) {
      return '❌ Blizzard has no record of that. Double-check the spelling, realm, and region.';
    }

    if (err.status === 401 || err.status === 403) {
      return '❌ The bot\'s Blizzard API credentials were rejected. An admin needs to check them.';
    }

    if (err.status === 429) {
      return '❌ The Blizzard API is rate limiting us right now. Try again in a moment.';
    }

    if (err.status >= 500) {
      return '❌ The Blizzard API is having problems right now. Try again shortly.';
    }

    return `❌ ${err.message}`;
  }

  return '❌ Something went wrong running that command.';
}

/**
 * Discord error codes meaning the interaction can no longer be answered:
 * 10062 the token is unknown or expired (the 3-second window lapsed, typically
 * because the bot was restarting when the command was invoked), and 40060 it has
 * already been acknowledged. Retrying either one just produces a second, more
 * confusing error.
 */
const DEAD_INTERACTION_CODES = new Set([10062, 40060]);

function isDeadInteraction(err) {
  return DEAD_INTERACTION_CODES.has(err?.code);
}

/**
 * Explains a dead interaction.
 *
 * The obvious reading of these codes is wrong, and cost a long debugging session:
 *
 *   10062 Unknown interaction  - Discord no longer has a record of it. The lazy
 *                                assumption is "we were too slow", but when the
 *                                interaction is still YOUNG this instead means
 *                                the record was already consumed -- i.e. ANOTHER
 *                                process sharing this token answered first, and
 *                                Discord retired the interaction before our
 *                                callback landed.
 *   40060 Already acknowledged - the same race, caught a moment earlier, while
 *                                the record still existed.
 *
 * So a duplicate instance usually surfaces as 10062, not 40060. `age` is what
 * separates the two readings: a young interaction exonerates this process.
 */
function describeDeadInteraction(err, interaction) {
  const created = interaction?.createdTimestamp;
  const ageMs = Number.isFinite(created) ? Date.now() - created : null;
  const age = ageMs === null ? 'age unknown' : `${ageMs}ms old`;

  // Comfortably inside Discord's 3s budget: we were not slow, so somebody else
  // must have answered.
  if (ageMs !== null && ageMs < 2000) {
    return (
      `${age}, well inside the 3000ms limit, so this process answered in time. ` +
      'The interaction was already consumed, which means ANOTHER INSTANCE sharing ' +
      'this bot token answered first. Check for a second `npm run dev` or `npm start` ' +
      'in this directory, and for a remote deployment using the same token.'
    );
  }

  if (err?.code === 40060) {
    return `already answered by someone else (${age}) — another instance is sharing this token.`;
  }

  return (
    `expired before it could be answered (${age}, Discord allows 3000ms). ` +
    'Either this process stalled, or the event arrived late.'
  );
}

/** Replies or edits, depending on whether the command already deferred. */
async function respondWithError(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    if (isDeadInteraction(err)) {
      console.warn('⚠️  Could not deliver an error response: the interaction is gone.');
      return;
    }
    console.error('Failed to deliver an error response:', err);
  }
}

/**
 * Guilds this instance has already reported ignoring.
 *
 * A pinned dev instance still receives every interaction from the busy
 * production guild. Logging each one would bury the dev console in noise, so
 * announce each guild once and then stay quiet.
 */
const ignoredGuilds = new Set();

function noteIgnoredGuild(guildId, configuredGuildId) {
  if (!guildId || ignoredGuilds.has(guildId)) return;

  ignoredGuilds.add(guildId);
  console.log(
    `↪️  Ignoring events from guild ${guildId} — this instance is pinned to ${configuredGuildId}. ` +
      'Further notices for that guild are suppressed.'
  );
}

/** Tests only. */
function resetIgnoredGuilds() {
  ignoredGuilds.clear();
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand?.()) return;

  // GUILD_ID pins this instance to one guild; blank means serve them all.
  // Pinning is what lets a production and a dev instance share one bot token
  // without racing for the right to answer.
  const configuredGuildId = readConfig().discord.guildId;

  if (!isGuildInScope(interaction.guildId, configuredGuildId)) {
    noteIgnoredGuild(interaction.guildId, configuredGuildId);
    return;
  }

  const command = interaction.client.commands?.get(interaction.commandName);

  if (!command) {
    // Reaching here while the command IS registered with Discord means this
    // process is running older code than whatever registered it — most often a
    // second instance sharing the token. Both copies receive every interaction,
    // and whichever answers first consumes the token, leaving the other to fail
    // with 10062. Say so, because the bare message sends people hunting in the
    // wrong place.
    console.warn(
      `⚠️  Received an unknown command: /${interaction.commandName}. ` +
        'This process does not have that command. If it exists in your source, ' +
        'another instance running older code is sharing this bot token.'
    );
    await respondWithError(interaction, '❌ That command is no longer available.');
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    // A dead interaction is not a command failure -- there is nothing to report
    // to and nothing to fix in the command, so log one line, not a stack trace.
    if (isDeadInteraction(err)) {
      console.warn(
        `⚠️  /${interaction.commandName} [${err.code}] ${describeDeadInteraction(err, interaction)}`
      );
      return;
    }

    console.error(`❌ Error running /${interaction.commandName}:`, err);
    await respondWithError(interaction, describeError(err));
  }
}

/** Wires the handler onto a client. */
function registerInteractionHandler(client, Events) {
  client.on(Events.InteractionCreate, handleInteraction);
}

module.exports = {
  DEAD_INTERACTION_CODES,
  describeDeadInteraction,
  describeError,
  isDeadInteraction,
  resetIgnoredGuilds,
  handleInteraction,
  registerInteractionHandler,
  respondWithError
};
