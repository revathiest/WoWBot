// commands/admin/voice.js
// /voice — configure "join to create" private voice channels.
//
// Permission is enforced in code as well as declared, for the reason given
// in commands/admin/spam.js: the default-member-permissions flag only hides
// a command in the UI and can be overridden per guild.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType
} = require('discord.js');

const store = require('../../utils/voice/store');
const { FALLBACK_COLOR } = require('../../utils/wow');

const data = new SlashCommandBuilder()
  .setName('voice')
  .setDescription('Configure "join to create" private voice channels.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub => sub.setName('status').setDescription('Show the current settings.'))
  .addSubcommand(sub =>
    sub
      .setName('set-channel')
      .setDescription('The voice channel that creates a private room when someone joins it.')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('Trigger voice channel.')
          .addChannelTypes(ChannelType.GuildVoice)
          .setRequired(true)
      )
      .addChannelOption(option =>
        option
          .setName('category')
          .setDescription('Where private rooms are created. Defaults to the trigger channel\'s own category.')
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(false)
      )
  )
  .addSubcommand(sub => sub.setName('disable').setDescription('Turn private voice channels off.'));

function buildStatusEmbed(settings) {
  const embed = new EmbedBuilder().setColor(FALLBACK_COLOR).setTitle('Private Voice Channels');

  if (!settings) {
    embed.setDescription(
      '⚪ Not set up. `/voice set-channel channel:#join-to-create` turns it on.'
    );
    return embed;
  }

  embed.setDescription(
    '🟢 Enabled — joining the trigger channel creates a private room, moves the member in, and ' +
      'gives them full control of it. It closes the moment they leave.'
  );

  embed.addFields(
    { name: 'Trigger channel', value: `<#${settings.triggerChannelId}>`, inline: true },
    {
      name: 'Created in',
      value: settings.categoryId ? `<#${settings.categoryId}>` : '_trigger channel\'s own category_',
      inline: true
    }
  );

  return embed;
}

async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: '❌ You need the Manage Server permission to use this.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'status') {
    await interaction.reply({
      embeds: [buildStatusEmbed(store.getSettings(interaction.guildId))],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === 'disable') {
    store.clearSettings(interaction.guildId);
    await interaction.reply({
      content:
        '⚪ Private voice channels are off. Any rooms already open are unaffected until their ' +
        'owner leaves — new joins to the old trigger channel will not create anything.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const channel = interaction.options.getChannel('channel');
  const category = interaction.options.getChannel('category');

  const changes = { triggerChannelId: channel.id };
  if (category) changes.categoryId = category.id;

  store.setSettings(interaction.guildId, changes);

  await interaction.reply({
    content:
      `✅ Joining <#${channel.id}> now creates a private voice channel, moves the member in, and ` +
      'gives them full control of it — rename it, limit it, move or mute whoever joins, lock it ' +
      'down entirely. It closes the moment they leave.',
    flags: MessageFlags.Ephemeral
  });
}

module.exports = {
  data,
  help: 'Turns a voice channel into a "join to create" trigger for private, self-owned voice rooms.',
  category: 'Admin',
  buildStatusEmbed,
  execute
};
