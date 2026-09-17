// utils/tickets/core.js
// The ticket workflow: a button in a lobby channel opens a modal, the modal
// creates a private channel, and moderators claim and close it from there.
//
// Ported from the Squadron 42 bot. The behaviour is the same; the storage is
// not (see store.js), and four things were fixed rather than copied:
//
//   1. The original requires the lobby channel to sit inside a category and
//      fails outright otherwise. Here a lobby at the root of the server just
//      means the ticket channel is created at the root too.
//   2. The original inserts the ticket row before creating the channel, so a
//      failed channel creation leaves a ticket that exists only in the
//      database. Here the id is reserved, the channel is made, and only then
//      is anything recorded.
//   3. The original's `isModerator` falls back to a permission check ONLY when
//      no moderator roles are configured — so adding one role locks out every
//      admin who does not hold it. Here Manage Server always counts.
//   4. The original has no limit on open tickets per person, and each one is a
//      real channel.

const { ChannelType, MessageFlags, PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const { preflight } = require('../spam/enforcement');
const { record } = require('../audit/log');
const store = require('./store');
const {
  CREATE_BUTTON_ID,
  CREATE_MODAL_ID,
  SUBJECT_INPUT_ID,
  buildClosedEmbed,
  buildLobbyComponents,
  buildLobbyEmbed,
  buildTicketChannelName,
  buildTicketControls,
  buildTicketEmbed,
  buildTicketModal
} = require('./ui');

const CLOSE_REASON = 'Ticket closed';

/**
 * Who may claim and close.
 *
 * Manage Server always qualifies. Without that, configuring a moderator role
 * would quietly lock out the server's own admins, which is exactly the sort of
 * thing nobody notices until a ticket needs closing at 2am.
 */
function isModerator(guildId, member) {
  if (!member) return false;

  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;

  const roles = store.getRoles(guildId);
  if (roles.length === 0) {
    // No roles configured yet: fall back to a permission that implies
    // moderation, so the system is usable the moment the lobby is set up.
    return member.permissions?.has?.(PermissionFlagsBits.ManageChannels) ?? false;
  }

  return roles.some(roleId => member.roles?.cache?.has?.(roleId)) ?? false;
}

/**
 * Permission overwrites for a new ticket channel: invisible to everyone except
 * the opener, the bot, and the moderator roles.
 */
function buildChannelOverwrites({ guild, botId, userId, roleIds }) {
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: new PermissionsBitField([PermissionFlagsBits.ViewChannel]).bitfield
    },
    {
      id: userId,
      allow: new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks
      ]).bitfield
    },
    {
      id: botId,
      allow: new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages
      ]).bitfield
    }
  ];

  for (const roleId of roleIds) {
    overwrites.push({
      id: roleId,
      allow: new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages
      ]).bitfield
    });
  }

  return overwrites;
}

/** Re-posts or repairs the lobby panel, so the button survives a restart. */
async function ensureLobbyMessage(client, guildId) {
  const settings = store.getSettings(guildId);
  if (!settings) return null;

  let guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch (err) {
    // A stale guild id from a bot that was removed; not worth a stack trace.
    console.warn(`⚠️  tickets: guild ${guildId} is unreachable, skipping lobby setup (${err.message}).`);
    return null;
  }

  let channel;
  try {
    channel = await guild.channels.fetch(settings.channelId);
  } catch (err) {
    console.warn(`⚠️  tickets: lobby channel ${settings.channelId} could not be fetched (${err.message}).`);
    return null;
  }

  if (!channel?.isTextBased?.()) {
    console.warn(`⚠️  tickets: lobby channel ${settings.channelId} is missing or not a text channel.`);
    return null;
  }

  const embed = buildLobbyEmbed(guild.name);
  const components = buildLobbyComponents();

  if (settings.messageId) {
    try {
      const existing = await channel.messages.fetch(settings.messageId);
      await existing.edit({ embeds: [embed], components });
      return existing;
    } catch {
      // Deleted by a moderator, or lost to a channel purge. Post a fresh one.
    }
  }

  try {
    const message = await channel.send({ embeds: [embed], components });
    store.setSettings(guildId, { messageId: message.id });
    return message;
  } catch (err) {
    console.error(`❌ tickets: could not post the lobby message in ${channel.id}: ${err.message}`);
    return null;
  }
}

/** The lobby is a button, not a chat room; stray messages are removed. */
async function handleLobbyMessage(message) {
  if (!message?.guild || message.author?.bot) return false;

  const settings = store.getSettings(message.guild.id);
  if (!settings || !settings.policeLobby) return false;
  if (settings.channelId !== (message.channel?.id ?? message.channelId)) return false;

  // Moderators may need to post notices there.
  if (message.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels)) return false;

  await message.delete().catch(() => null);

  const notice =
    'That channel is only for opening tickets — use the **Open Ticket** button and your message ' +
    'will go to the moderators privately.';

  try {
    await message.author.send(notice);
  } catch {
    // DMs closed: say it in the channel instead, and clean up after ourselves
    // so the lobby does not fill with bot notices.
    try {
      const warning = await message.channel.send({
        content: `<@${message.author.id}> ${notice}`,
        allowedMentions: { users: [message.author.id] }
      });
      setTimeout(() => warning.delete().catch(() => null), 10000).unref?.();
    } catch (err) {
      console.warn(`⚠️  tickets: could not tell ${message.author.id} about the lobby: ${err.message}`);
    }
  }

  return true;
}

/** The "Open Ticket" button: check it came from the lobby, then show the form. */
async function handleCreateButton(interaction) {
  const settings = store.getSettings(interaction.guildId);

  if (!settings || settings.channelId !== interaction.channelId) {
    await interaction.reply({
      content: '❌ Tickets can only be opened from the ticket channel.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (store.openCountFor(interaction.guildId, interaction.user.id) >= store.MAX_OPEN_PER_USER) {
    await interaction.reply({
      content:
        `❌ You already have ${store.MAX_OPEN_PER_USER} open tickets. ` +
        'Please use one of those, or wait for a moderator to close it.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.showModal(buildTicketModal());
}

/** The modal submission: create the channel, post the controls, record it. */
async function createTicket(interaction) {
  const settings = store.getSettings(interaction.guildId);

  if (!settings) {
    await interaction.reply({
      content: '❌ The ticket system is not configured for this server.',
      flags: MessageFlags.Ephemeral
    });
    return null;
  }

  const description = interaction.fields.getTextInputValue(SUBJECT_INPUT_ID);
  const guild = interaction.guild;
  const roleIds = store.getRoles(interaction.guildId);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Reserved before the channel exists because the id is part of its name, but
  // nothing is recorded until the channel is really there.
  const ticketId = store.reserveId();
  const displayName = interaction.member?.displayName || interaction.user.username;

  const lobbyChannel = await guild.channels.fetch(settings.channelId).catch(() => null);

  let channel;
  try {
    channel = await guild.channels.create({
      name: buildTicketChannelName(displayName, ticketId),
      type: ChannelType.GuildText,
      // A lobby at the root of the server is fine; the ticket goes there too.
      parent: lobbyChannel?.parent ?? null,
      permissionOverwrites: buildChannelOverwrites({
        guild,
        botId: interaction.client.user.id,
        userId: interaction.user.id,
        roleIds
      })
    });
  } catch (err) {
    console.error(`❌ tickets: could not create a ticket channel: ${err.message}`);
    await interaction.editReply(
      '❌ Could not create your ticket channel. A moderator needs to check the bot\'s ' +
        'Manage Channels permission.'
    );
    return null;
  }

  const mentions = [`<@${interaction.user.id}>`, ...roleIds.map(roleId => `<@&${roleId}>`)].join(' ');

  const controlMessage = await channel.send({
    content: mentions,
    embeds: [buildTicketEmbed({ user: interaction.user, description, ticketId })],
    components: buildTicketControls(ticketId),
    allowedMentions: { users: [interaction.user.id], roles: roleIds }
  });

  const ticket = store.openTicket({
    id: ticketId,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    channelId: channel.id,
    controlMessageId: controlMessage.id,
    description
  });

  record(interaction.client, {
    kind: 'ticket',
    action: `opened ticket #${ticketId}`,
    actorId: interaction.user.id,
    channelId: channel.id,
    category: 'Admin'
  });

  await interaction.editReply(`✅ Ticket created: ${channel.toString()}`);
  return ticket;
}

/** Keeps the control buttons in step with the ticket's state. */
async function updateControls(channel, ticket, { claimedByLabel = null, closed = false } = {}) {
  if (!ticket.controlMessageId) return;

  try {
    const message = await channel.messages.fetch(ticket.controlMessageId);
    await message.edit({ components: buildTicketControls(ticket.id, claimedByLabel, { closed }) });
  } catch {
    // The control message was deleted; the ticket itself is unaffected.
  }
}

async function handleClaim(interaction, ticketId) {
  const ticket = store.getOpenById(ticketId);

  if (!ticket) {
    await interaction.reply({
      content: '❌ That ticket could not be found, or it is already closed.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!isModerator(interaction.guildId, interaction.member)) {
    await interaction.reply({
      content: '❌ Only ticket moderators can claim tickets.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (ticket.claimedBy) {
    await interaction.reply({
      content: `❌ This ticket has already been claimed by <@${ticket.claimedBy}>.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  store.updateTicket(ticket.channelId, { claimedBy: interaction.user.id });

  await updateControls(interaction.channel, ticket, {
    claimedByLabel: interaction.member?.displayName || interaction.user.username
  });

  record(interaction.client, {
    kind: 'ticket',
    action: `claimed ticket #${ticket.id}`,
    actorId: interaction.user.id,
    channelId: interaction.channel?.id,
    category: 'Admin'
  });

  await interaction.reply({ content: `🙋 Ticket claimed by <@${interaction.user.id}>.` });
}

async function handleClose(interaction, ticketId) {
  const ticket = store.getOpenById(ticketId);

  if (!ticket) {
    await interaction.reply({
      content: '❌ That ticket could not be found, or it is already closed.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!isModerator(interaction.guildId, interaction.member)) {
    await interaction.reply({
      content: '❌ Only ticket moderators can close tickets.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const closed = store.closeTicket(ticket.channelId, { closedBy: interaction.user.id });
  const settings = store.getSettings(interaction.guildId);
  const channel = interaction.channel;

  record(interaction.client, {
    kind: 'ticket',
    action: `closed ticket #${ticket.id}`,
    actorId: interaction.user.id,
    channelId: channel?.id,
    detail: ticket.claimedBy ? `claimed by <@${ticket.claimedBy}>` : 'never claimed',
    category: 'Admin'
  });

  // Answer before rearranging the channel — editing permissions and moving it
  // between categories takes long enough to risk the interaction expiring.
  await interaction.reply({ embeds: [buildClosedEmbed({ ticket: closed, closedBy: interaction.user.id })] });

  // Keep whoever claimed it on the button, so the closed channel still records
  // who handled it. A claimer who has since left the server simply has no
  // display name to show.
  const claimer = ticket.claimedBy
    ? interaction.guild?.members?.cache?.get?.(ticket.claimedBy)
    : null;

  await updateControls(channel, ticket, {
    claimedByLabel: claimer?.displayName ?? claimer?.user?.username ?? null,
    closed: true
  });

  // The opener loses access; moderators keep read access for the record.
  await channel.permissionOverwrites
    ?.edit(ticket.userId, { ViewChannel: false, SendMessages: false })
    .catch(() => null);

  for (const roleId of store.getRoles(interaction.guildId)) {
    await channel.permissionOverwrites?.edit(roleId, { SendMessages: false }).catch(() => null);
  }

  if (settings?.archiveCategoryId) {
    await channel
      .setParent(settings.archiveCategoryId, { lockPermissions: false, reason: CLOSE_REASON })
      .catch(err => console.warn(`⚠️  tickets: could not archive ${channel.id}: ${err.message}`));
  }
}

/**
 * Routes a button or modal interaction.
 *
 * @returns {Promise<boolean>} whether this module handled it.
 */
async function handleComponent(interaction) {
  const customId = interaction.customId ?? '';

  if (!customId.startsWith('ticket:')) return false;

  if (interaction.isModalSubmit?.()) {
    if (customId === CREATE_MODAL_ID) {
      await createTicket(interaction);
      return true;
    }
    return false;
  }

  if (!interaction.isButton?.()) return false;

  if (customId === CREATE_BUTTON_ID) {
    await handleCreateButton(interaction);
    return true;
  }

  const [, action, rawId] = customId.split(':');
  const ticketId = Number(rawId);

  if (!Number.isFinite(ticketId)) {
    await interaction.reply({ content: '❌ That button is malformed.', flags: MessageFlags.Ephemeral });
    return true;
  }

  if (action === 'claim') {
    await handleClaim(interaction, ticketId);
    return true;
  }

  if (action === 'close') {
    await handleClose(interaction, ticketId);
    return true;
  }

  console.warn(`⚠️  tickets: unrecognised button action "${action}".`);
  return false;
}

module.exports = {
  CLOSE_REASON,
  buildChannelOverwrites,
  createTicket,
  ensureLobbyMessage,
  handleClaim,
  handleClose,
  handleComponent,
  handleCreateButton,
  handleLobbyMessage,
  isModerator,
  updateControls
};
