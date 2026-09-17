// utils/reports/component.js
// The "who is on Discord?" button under each report.
//
// The report itself carries only the two counts, because a list of two hundred
// names would bury everything else in it. Pressing the button sends the full
// breakdown as a DM — private, as long as the reader wants, and it does not
// clutter the channel that gets wiped before each post.

const { EmbedBuilder, MessageFlags } = require('discord.js');

const { loadSnapshot } = require('./history');
const { buildOwnerIndex } = require('./links');
const { countByDiscord, fetchPresentUserIds, splitByDiscord } = require('./membership');
const { ROSTER_BUTTON_PREFIX } = require('./render');
const { FALLBACK_COLOR } = require('../wow');

const MAX_FIELD_LENGTH = 1024;

// Ten fields of names is already a long DM; past that the answer is "look at
// the guild roster", not a longer message.
const MAX_FIELDS_PER_GROUP = 4;

/** Packs names into field-sized chunks, so a long list survives Discord's caps. */
function nameFields(label, members, { emoji = '' } = {}) {
  if (members.length === 0) return [];

  const names = members.map(member => member.name);
  const fields = [];
  let current = [];
  let length = 0;

  // Leave room for the ", _and N more_" that may be appended to the last chunk;
  // adding it after packing to exactly 1024 would push the field over.
  const limit = MAX_FIELD_LENGTH - 40;

  for (const name of names) {
    if (current.length > 0 && length + name.length + 2 > limit) {
      fields.push(current);
      current = [];
      length = 0;
    }

    current.push(name);
    length += name.length + 2;
  }

  if (current.length > 0) fields.push(current);

  const shown = fields.slice(0, MAX_FIELDS_PER_GROUP);
  const dropped = fields.slice(MAX_FIELDS_PER_GROUP).reduce((sum, chunk) => sum + chunk.length, 0);

  return shown.map((chunk, index) => ({
    name: index === 0 ? `${emoji} ${label} (${members.length})` : `${label} (continued)`,
    value:
      chunk.join(', ') +
      (index === shown.length - 1 && dropped > 0 ? `, _and ${dropped} more_` : '')
  }));
}

/** The DM: who is reachable on Discord, who has left, and who was never linked. */
function buildBreakdownEmbed({ guild, split }) {
  const counts = countByDiscord(split);

  const embed = new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle(`${guild?.name ?? 'Guild'} — Discord breakdown`)
    .setDescription(
      `**${counts.onDiscord}** of ${counts.total} roster members are on Discord; ` +
        `**${counts.notOnDiscord}** are not.`
    );

  embed.addFields(
    ...nameFields('On Discord', split.onDiscord, { emoji: '🟢' }),
    ...nameFields('Linked, but left the server', split.left, { emoji: '🚪' }),
    ...nameFields('Not linked to anyone', split.unlinked, { emoji: '⚪' })
  );

  if (split.unlinked.length > 0) {
    // The honest caveat: an unlinked character is not proof of absence.
    embed.addFields({
      name: 'About "not linked"',
      value:
        'The bot can only connect a character to a Discord account when somebody claims it with ' +
        '`/iam add`, or an admin assigns it with `/iam manage assign`. Anyone in this list may ' +
        'well be in the server without having done that.'
    });
  }

  return embed;
}

/**
 * Handles the roster button.
 *
 * @returns {Promise<boolean>} whether this module handled the interaction.
 */
async function handleComponent(interaction) {
  const customId = interaction.customId ?? '';

  if (!interaction.isButton?.() || !customId.startsWith(ROSTER_BUTTON_PREFIX)) return false;

  const key = customId.slice(ROSTER_BUTTON_PREFIX.length);
  const snapshot = loadSnapshot(key);

  if (!snapshot) {
    await interaction.reply({
      content:
        '❌ There is no stored roster for that guild any more. The next report will record one.',
      flags: MessageFlags.Ephemeral
    });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const realmSlug = snapshot.guild?.realmSlug ?? snapshot.guild?.realm;
  const members = Object.values(snapshot.members ?? {}).map(member => ({
    name: member.name,
    level: member.level,
    className: member.className
  }));

  const presentUserIds = interaction.guild ? await fetchPresentUserIds(interaction.guild) : null;
  const split = splitByDiscord(members, realmSlug, buildOwnerIndex(), presentUserIds);
  const embed = buildBreakdownEmbed({ guild: snapshot.guild, split });

  try {
    await interaction.user.send({ embeds: [embed] });
    await interaction.editReply('📬 Sent you the breakdown by DM.');
  } catch {
    // DMs closed is common enough that falling back beats failing.
    await interaction.editReply({
      content: '⚠️ I could not DM you, so here it is instead.',
      embeds: [embed]
    });
  }

  return true;
}

module.exports = { MAX_FIELDS_PER_GROUP, buildBreakdownEmbed, handleComponent, nameFields };
