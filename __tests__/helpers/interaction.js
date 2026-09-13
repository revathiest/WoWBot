// __tests__/helpers/interaction.js
// A minimal stand-in for a discord.js ChatInputCommandInteraction.

function createInteraction({ options = {}, commandName = 'test', commands } = {}) {
  return {
    commandName,
    client: { commands },
    options: {
      getString: name => (name in options ? options[name] : null)
    },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    deferReply: jest.fn(async function deferReply() {
      this.deferred = true;
    }),
    editReply: jest.fn(async () => {}),
    reply: jest.fn(async function reply() {
      this.replied = true;
    })
  };
}

/** The payload passed to editReply, whether it was a string or an options object. */
function replyPayload(interaction) {
  const [payload] = interaction.editReply.mock.calls[interaction.editReply.mock.calls.length - 1];
  return payload;
}

/** The first embed of the most recent editReply, converted to plain JSON. */
function replyEmbed(interaction) {
  const payload = replyPayload(interaction);
  return payload.embeds[0].toJSON();
}

/** Looks up an embed field by name. */
function field(embed, name) {
  return (embed.fields ?? []).find(entry => entry.name === name);
}

module.exports = { createInteraction, field, replyEmbed, replyPayload };
