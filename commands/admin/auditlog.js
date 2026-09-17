// commands/admin/auditlog.js
// /auditlog — where the bot records what it did.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType
} = require('discord.js');

const { VERBOSITY, loadConfig, saveConfig } = require('../../utils/audit/config');
const { record } = require('../../utils/audit/log');
const { lockChannel } = require('../../utils/channelLock');
const { FALLBACK_COLOR } = require('../../utils/wow');

const VERBOSITY_CHOICES = [
  { name: 'all — every command and action', value: 'all' },
  { name: 'admin — config, moderation, and anything automatic', value: 'admin' },
  { name: 'off — nothing', value: 'off' }
];

const data = new SlashCommandBuilder()
  .setName('auditlog')
  .setDescription('Record what the bot does to a channel.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub => sub.setName('status').setDescription('Show the audit log settings.'))
  .addSubcommand(sub =>
    sub
      .setName('channel')
      .setDescription('Where the log is written.')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('Log channel.')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('enabled')
      .setDescription('Turn the audit log on or off.')
      .addBooleanOption(option =>
        option.setName('value').setDescription('On or off.').setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('verbosity')
      .setDescription('How much to record.')
      .addStringOption(option =>
        option
          .setName('level')
          .setDescription('How much detail to keep.')
          .addChoices(...VERBOSITY_CHOICES)
          .setRequired(true)
      )
  );

const VERBOSITY_BLURB = {
  all: 'Every command and button press, plus everything the bot does on its own.',
  admin: 'Configuration and moderation commands, plus everything the bot does on its own. ' +
    'Ordinary lookups like `/character` are skipped.',
  off: 'Nothing is recorded.'
};

function buildStatusEmbed(config) {
  return new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle('Audit log')
    .setDescription(
      config.enabled && config.channelId
        ? `🟢 Writing to <#${config.channelId}>.`
        : '⚪ Off — set a channel, then `/auditlog enabled value:true`.'
    )
    .addFields(
      {
        name: 'Channel',
        value: config.channelId ? `<#${config.channelId}>` : '_not set_',
        inline: true
      },
      { name: 'Verbosity', value: config.verbosity, inline: true },
      { name: 'What that means', value: VERBOSITY_BLURB[config.verbosity] },
      {
        name: 'Note',
        value:
          'Spam enforcement and the onboarding sweep keep their own detailed alert channels. ' +
          'This is the flat, chronological feed of everything.'
      }
    );
}

/**
 * The log channel is hidden, not merely read-only: it names who ran what and
 * carries moderation outcomes, which is not something the whole server should
 * be reading over the moderators' shoulders.
 */
async function setChannel(interaction) {
  const channel = interaction.options.getChannel('channel');

  const lock = await lockChannel(channel, {
    botId: interaction.client.user.id,
    visibility: 'admins',
    reason: 'Audit log: admin-only, bot-writable'
  });

  const next = saveConfig({ channelId: channel.id });
  const lines = [];

  if (lock.ok) {
    lines.push(
      `🔒 <#${channel.id}> is now hidden from everyone except the bot and roles that can manage ` +
        'the server, and only the bot can post in it.'
    );

    if (lock.grantedRoles.length > 0) {
      lines.push(`Visible to ${lock.grantedRoles.map(id => `<@&${id}>`).join(', ')}.`);
    }

    if (lock.warnings.length > 0) lines.push(`⚠️ ${lock.warnings.join('; ')}.`);
  } else {
    lines.push(
      `⚠️ <#${channel.id}> could **not** be locked — ${lock.reason}. The log will still be ` +
        'written there, but anyone who can see the channel can read it.'
    );
  }

  lines.push(
    next.enabled
      ? `✅ The audit log now writes to <#${channel.id}>.`
      : `✅ Log channel set. Turn it on with \`/auditlog enabled value:true\`.`
  );

  return lines.join('\n');
}

function configure(subcommand, interaction) {
  if (subcommand === 'enabled') {
    const value = interaction.options.getBoolean('value');

    if (!value) {
      saveConfig({ enabled: false });
      return '⚪ The audit log is off.';
    }

    if (!loadConfig().channelId) {
      return '❌ Set a channel first: `/auditlog channel channel:#bot-log`.';
    }

    const next = saveConfig({ enabled: true });
    return `🟢 Recording to <#${next.channelId}> at verbosity **${next.verbosity}**.`;
  }

  const level = interaction.options.getString('level');
  const next = saveConfig({ verbosity: level });

  return `✅ Verbosity set to **${next.verbosity}** — ${VERBOSITY_BLURB[next.verbosity]}`;
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
      embeds: [buildStatusEmbed(loadConfig())],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Editing channel permissions is several round trips.
  if (subcommand === 'channel') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await setChannel(interaction);

    record(interaction.client, {
      kind: 'config',
      action: 'set the audit log channel',
      actorId: interaction.user.id,
      channelId: interaction.channelId,
      category: 'Admin'
    });

    await interaction.editReply(result);
    return;
  }

  const message = configure(subcommand, interaction);

  // Changing what gets recorded is itself worth recording.
  record(interaction.client, {
    kind: 'config',
    action: 'changed the audit log settings',
    actorId: interaction.user.id,
    channelId: interaction.channelId,
    detail: subcommand,
    category: 'Admin'
  });

  await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

module.exports = {
  data,
  help: 'Records what the bot does to a channel.',
  category: 'Admin',
  VERBOSITY,
  buildStatusEmbed,
  configure,
  execute,
  setChannel
};
