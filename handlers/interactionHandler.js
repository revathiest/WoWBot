// handlers/interactionHandler.js
// Routes chat-input interactions to their command module and keeps failures contained.

const { MessageFlags } = require('discord.js');
const { BlizzardApiError } = require('../utils/blizzard/client');

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

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand?.()) return;

  const command = interaction.client.commands?.get(interaction.commandName);

  if (!command) {
    console.warn(`⚠️  Received an unknown command: ${interaction.commandName}`);
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
        `⚠️  /${interaction.commandName} could not be answered: the interaction expired. ` +
          'This usually means the bot was restarting when the command was used.'
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
  describeError,
  isDeadInteraction,
  handleInteraction,
  registerInteractionHandler,
  respondWithError
};
