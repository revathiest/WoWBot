// utils/tickets/ui.js
// Every embed, button, and modal the ticket system shows.
//
// Kept apart from the flow logic in core.js so the wording and the custom ids
// can be asserted in tests without standing up a fake guild. The custom id
// format is the contract between the two: `ticket:<action>[:<ticketId>]`, which
// is what interactionHandler routes on.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const { FALLBACK_COLOR } = require('../wow');

const CUSTOM_ID_PREFIX = 'ticket:';
const CREATE_BUTTON_ID = 'ticket:create';
const CREATE_MODAL_ID = 'ticket:modal:create';
const SUBJECT_INPUT_ID = 'ticket:subject';

const TICKET_COLOR = 0x2b2d31;
const CLOSED_COLOR = 0x9d9d9d;

// Discord caps a channel name at 100 characters; the prefix and id need room.
const MAX_NAME_SEGMENT = 60;

/** Channel names are lowercase, alphanumeric, and hyphen-separated. */
function sanitizeNameSegment(value) {
  const collapsed = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, MAX_NAME_SEGMENT);

  // A display name of only emoji or non-Latin script collapses to nothing.
  return collapsed || 'user';
}

function buildTicketChannelName(userDisplay, ticketId) {
  return `ticket-${sanitizeNameSegment(userDisplay)}-${ticketId}`;
}

/** The permanent panel that lives in the lobby channel. */
function buildLobbyEmbed(guildName) {
  return new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle('Need Assistance?')
    .setDescription('Click the button below to open a private ticket with the moderation team.')
    .addFields(
      {
        name: 'How it works',
        value:
          '1. Press **Open Ticket**.\n' +
          '2. Describe your issue in the form.\n' +
          '3. A moderator will claim your ticket and follow up in a private channel.'
      },
      {
        name: 'Reminder',
        value: guildName
          ? `Tickets in ${guildName} are for support questions and issue reporting.`
          : 'Tickets are intended for support questions and issue reporting.'
      }
    );
}

function buildLobbyComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CREATE_BUTTON_ID)
        .setLabel('Open Ticket')
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

/**
 * The claim/close controls posted inside a ticket channel.
 *
 * `claimedByLabel` is a display name rather than a mention because it becomes a
 * button label, and Discord does not render mentions there.
 */
function buildTicketControls(ticketId, claimedByLabel = null, { closed = false } = {}) {
  const claim = new ButtonBuilder()
    .setCustomId(`ticket:claim:${ticketId}`)
    .setLabel(claimedByLabel ? `Claimed by ${claimedByLabel}`.slice(0, 80) : 'Claim Ticket')
    .setStyle(claimedByLabel ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setDisabled(Boolean(claimedByLabel) || closed);

  const close = new ButtonBuilder()
    .setCustomId(`ticket:close:${ticketId}`)
    .setLabel(closed ? 'Closed' : 'Close Ticket')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(closed);

  return [new ActionRowBuilder().addComponents(claim, close)];
}

function buildTicketModal() {
  return new ModalBuilder()
    .setCustomId(CREATE_MODAL_ID)
    .setTitle('Open a Support Ticket')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(SUBJECT_INPUT_ID)
          .setLabel('What do you need help with?')
          .setMinLength(10)
          .setMaxLength(400)
          .setRequired(true)
          .setStyle(TextInputStyle.Paragraph)
      )
    );
}

/** The opening post inside a ticket channel. */
function buildTicketEmbed({ user, description, ticketId }) {
  return new EmbedBuilder()
    .setColor(TICKET_COLOR)
    .setTitle(`Ticket #${ticketId}`)
    .setDescription(description)
    .addFields({ name: 'Opened by', value: `<@${user.id}>`, inline: true })
    .setTimestamp(new Date());
}

/** Posted in the channel when a ticket is closed, so the outcome is visible. */
function buildClosedEmbed({ ticket, closedBy }) {
  const embed = new EmbedBuilder()
    .setColor(CLOSED_COLOR)
    .setTitle(`Ticket #${ticket.id} closed`)
    .addFields(
      { name: 'Opened by', value: `<@${ticket.userId}>`, inline: true },
      { name: 'Closed by', value: `<@${closedBy}>`, inline: true }
    )
    .setTimestamp(new Date());

  if (ticket.claimedBy) {
    embed.addFields({ name: 'Claimed by', value: `<@${ticket.claimedBy}>`, inline: true });
  }

  return embed;
}

/** One line of `/ticket history`. */
function historyLine(ticket) {
  const state = ticket.closedAt ? 'closed' : 'open';
  const when = ticket.createdAt ? `<t:${Math.floor(ticket.createdAt / 1000)}:R>` : 'unknown';
  const summary = ticket.description.replace(/\s+/g, ' ').slice(0, 80);

  return (
    `\`#${ticket.id}\` <@${ticket.userId}> — **${state}** ${when}` +
    `${summary ? `\n> ${summary}${ticket.description.length > 80 ? '…' : ''}` : ''}`
  );
}

function buildHistoryEmbed({ tickets, userId = null }) {
  return new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle(userId ? 'Ticket history' : 'Recent tickets')
    .setDescription(
      tickets.length > 0
        ? tickets.map(historyLine).join('\n')
        : userId
          ? `<@${userId}> has never opened a ticket.`
          : 'No tickets have been opened yet.'
    );
}

module.exports = {
  CLOSED_COLOR,
  CREATE_BUTTON_ID,
  CREATE_MODAL_ID,
  CUSTOM_ID_PREFIX,
  MAX_NAME_SEGMENT,
  SUBJECT_INPUT_ID,
  TICKET_COLOR,
  buildClosedEmbed,
  buildHistoryEmbed,
  buildLobbyComponents,
  buildLobbyEmbed,
  buildTicketChannelName,
  buildTicketControls,
  buildTicketEmbed,
  buildTicketModal,
  historyLine,
  sanitizeNameSegment
};
