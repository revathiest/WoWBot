// commands/admin/ticket.js
// /ticket — configures the ticket system and looks up ticket history.
//
// The member-facing half of the system is the button in the lobby channel, not
// a command; this is only the moderator side. Permission is enforced in code as
// well as declared, for the reason given in commands/admin/spam.js.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType
} = require('discord.js');

const store = require('../../utils/tickets/store');
const { ensureLobbyMessage } = require('../../utils/tickets/core');
const { buildHistoryEmbed } = require('../../utils/tickets/ui');
const { isLocked, lockChannel } = require('../../utils/channelLock');
const { FALLBACK_COLOR } = require('../../utils/wow');

const MAX_HISTORY = 15;

const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Configure and inspect the support ticket system.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(sub =>
    sub
      .setName('set-channel')
      .setDescription('Designate the ticket lobby channel and post the panel there.')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('Channel where members open tickets.')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
      .addChannelOption(option =>
        option
          .setName('archive_category')
          .setDescription('Category closed tickets are moved to.')
          .addChannelTypes(ChannelType.GuildCategory)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('set-archive')
      .setDescription('Set the category closed tickets are moved to.')
      .addChannelOption(option =>
        option
          .setName('category')
          .setDescription('Archive category.')
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('lobby-policing')
      .setDescription('Whether stray messages in the lobby channel are deleted.')
      .addBooleanOption(option =>
        option.setName('value').setDescription('On or off.').setRequired(true)
      )
  )
  .addSubcommand(sub => sub.setName('status').setDescription('Show the ticket configuration.'))
  .addSubcommand(sub =>
    sub
      .setName('history')
      .setDescription('Recent tickets, optionally for one member.')
      .addUserOption(option =>
        option.setName('user').setDescription('Only show this member\'s tickets.')
      )
  )
  .addSubcommandGroup(group =>
    group
      .setName('roles')
      .setDescription('Manage which roles can claim and close tickets.')
      .addSubcommand(sub =>
        sub
          .setName('add')
          .setDescription('Let a role manage tickets.')
          .addRoleOption(option =>
            option.setName('role').setDescription('Role to add.').setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('remove')
          .setDescription('Stop a role from managing tickets.')
          .addRoleOption(option =>
            option.setName('role').setDescription('Role to remove.').setRequired(true)
          )
      )
      .addSubcommand(sub => sub.setName('list').setDescription('Show the ticket moderator roles.'))
  );

function buildStatusEmbed(guildId, channel = null) {
  const settings = store.getSettings(guildId);
  const roles = store.getRoles(guildId);
  const open = Object.values(store.load().open).filter(ticket => ticket.guildId === String(guildId));

  const embed = new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle('Ticket System')
    .setDescription(
      settings
        ? `🟢 Active — members open tickets from <#${settings.channelId}>.`
        : '⚪ Not set up — run `/ticket set-channel channel:#support` to post the panel.'
    );

  if (settings) {
    embed.addFields(
      { name: 'Lobby', value: `<#${settings.channelId}>`, inline: true },
      {
        name: 'Archive',
        value: settings.archiveCategoryId ? `<#${settings.archiveCategoryId}>` : '_not set_',
        inline: true
      },
      { name: 'Lobby policing', value: settings.policeLobby ? 'on' : 'off', inline: true },
      {
        name: 'Channel',
        value: channel ? (isLocked(channel) ? '🔒 read-only' : '⚠️ writable') : 'unknown',
        inline: true
      }
    );
  }

  embed.addFields(
    {
      name: 'Moderator roles',
      value: roles.length > 0 ? roles.map(id => `<@&${id}>`).join(' ') : '_none — Manage Channels is used instead_'
    },
    { name: 'Open tickets', value: String(open.length), inline: true },
    { name: 'In history', value: String(store.load().closed.length), inline: true }
  );

  return embed;
}

async function setChannel(interaction) {
  const channel = interaction.options.getChannel('channel');
  const archive = interaction.options.getChannel('archive_category');
  const existing = store.getSettings(interaction.guildId);

  // Moving the lobby leaves an orphaned panel behind, and two live panels is
  // worse than none — the old one's button still works.
  if (existing?.messageId && existing.channelId !== channel.id) {
    try {
      const previous = await interaction.guild.channels.fetch(existing.channelId);
      const message = await previous?.messages?.fetch(existing.messageId);
      await message?.delete();
    } catch {
      // Already gone, or the channel was deleted. Nothing to clean up.
    }
  }

  store.setSettings(interaction.guildId, {
    channelId: channel.id,
    // Forget the old panel id so a fresh one is posted below.
    messageId: null,
    ...(archive ? { archiveCategoryId: archive.id } : {})
  });

  // Locked before the panel goes up, so nobody can slip a message in between
  // the two. This is a stronger version of lobby policing: policing deletes
  // stray messages after the fact, the lock stops them being sent at all.
  const lock = await lockChannel(channel, {
    botId: interaction.client.user.id,
    reason: 'Ticket lobby: read-only'
  });

  const message = await ensureLobbyMessage(interaction.client, interaction.guildId);

  if (!message) {
    return (
      `⚠️ Saved <#${channel.id}> as the ticket lobby, but the panel could not be posted. ` +
      'Check that the bot can View Channel, Send Messages, and Embed Links there, then re-run this.'
    );
  }

  const lines = [
    `✅ Ticket lobby set to <#${channel.id}> and the panel posted.` +
      (archive ? ` Closed tickets will be moved to <#${archive.id}>.` : '')
  ];

  if (lock.ok) {
    lines.push(
      '🔒 The channel is read-only — everyone can see the panel and press the button, but only ' +
        'the bot can post, so the panel cannot be pushed out of view.'
    );

    if (lock.clearedRoles.length > 0) {
      lines.push(
        `Also revoked posting from ${lock.clearedRoles.map(id => `<@&${id}>`).join(', ')}, which ` +
          'had channel-specific permission to post.'
      );
    }

    lines.push(
      '_Administrators bypass channel permissions; lobby policing deletes anything that does ' +
        'get through._'
    );
  } else {
    lines.push(
      `⚠️ The channel could **not** be locked — ${lock.reason}. Lobby policing will still delete ` +
        'stray messages, but people can post there.'
    );
  }

  lines.push('Add the roles that should handle tickets with `/ticket roles add`.');

  return lines.join('\n');
}

function setArchive(interaction) {
  const category = interaction.options.getChannel('category');

  if (!store.getSettings(interaction.guildId)) {
    return '❌ Set the lobby first: `/ticket set-channel channel:#support`.';
  }

  store.setSettings(interaction.guildId, { archiveCategoryId: category.id });
  return `✅ Closed tickets will be moved to <#${category.id}>.`;
}

function roles(subcommand, interaction) {
  if (subcommand === 'list') {
    const current = store.getRoles(interaction.guildId);

    return current.length > 0
      ? `Ticket moderator roles: ${current.map(id => `<@&${id}>`).join(' ')}`
      : 'No moderator roles are set. Anyone with Manage Channels can claim and close tickets.';
  }

  const role = interaction.options.getRole('role');

  if (subcommand === 'add') {
    const { added } = store.addRole(interaction.guildId, role.id);

    return added
      ? `✅ <@&${role.id}> can now claim and close tickets, and will be pinged on new ones.`
      : `⚠️ <@&${role.id}> is already a ticket moderator role.`;
  }

  const { removed } = store.removeRole(interaction.guildId, role.id);

  return removed
    ? `✅ <@&${role.id}> can no longer manage tickets.`
    : `⚠️ <@&${role.id}> was not a ticket moderator role.`;
}

async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: '❌ You need the Manage Server permission to use this.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (group === 'roles') {
    await interaction.reply({ content: roles(subcommand, interaction), flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === 'status') {
    const settings = store.getSettings(interaction.guildId);
    const lobby = settings
      ? await interaction.guild?.channels?.fetch(settings.channelId).catch(() => null)
      : null;

    await interaction.reply({
      embeds: [buildStatusEmbed(interaction.guildId, lobby)],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === 'history') {
    const user = interaction.options.getUser('user');
    const tickets = store.history({
      guildId: interaction.guildId,
      userId: user?.id ?? null,
      limit: MAX_HISTORY
    });

    await interaction.reply({
      embeds: [buildHistoryEmbed({ tickets, userId: user?.id ?? null })],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (subcommand === 'set-archive') {
    await interaction.reply({ content: setArchive(interaction), flags: MessageFlags.Ephemeral });
    return;
  }

  if (subcommand === 'lobby-policing') {
    const value = interaction.options.getBoolean('value');
    store.setSettings(interaction.guildId, { policeLobby: value });

    await interaction.reply({
      content: value
        ? '✅ Stray messages in the lobby will be deleted, and the sender told why.'
        : '✅ The lobby channel will be left alone.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Posting the panel is a round trip to Discord.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(await setChannel(interaction));
}

module.exports = {
  data,
  help: 'Configures the support ticket system and shows ticket history.',
  category: 'Admin',
  buildStatusEmbed,
  execute,
  roles,
  setArchive
};
