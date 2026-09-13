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

/** Replies or edits, depending on whether the command already deferred. */
async function respondWithError(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
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
    console.error(`❌ Error running /${interaction.commandName}:`, err);
    await respondWithError(interaction, describeError(err));
  }
}

/** Wires the handler onto a client. */
function registerInteractionHandler(client, Events) {
  client.on(Events.InteractionCreate, handleInteraction);
}

module.exports = {
  describeError,
  handleInteraction,
  registerInteractionHandler,
  respondWithError
};
