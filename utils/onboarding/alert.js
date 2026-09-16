// utils/onboarding/alert.js
// What members are told, and what moderators see afterwards.
//
// With no database, the alert channel IS the record of who was removed and why,
// so the summary carries enough to answer "what happened to that person?" a
// week later without digging through logs.

const { EmbedBuilder } = require('discord.js');

const { daysRemaining } = require('./classify');

const COLOR_KICK = 0xff2222;
const COLOR_WARN = 0xff8c00;
const COLOR_QUIET = 0x9d9d9d;
const COLOR_PREVIEW = 0x5865f2;

// Discord's field cap; a long list is trimmed rather than rejected wholesale.
const MAX_FIELD_LENGTH = 1024;
const MAX_LISTED = 15;

function listField(lines) {
  const shown = [];
  let length = 0;
  let dropped = lines.length;

  for (const line of lines.slice(0, MAX_LISTED)) {
    if (length + line.length + 1 > MAX_FIELD_LENGTH - 40) break;
    shown.push(line);
    length += line.length + 1;
    dropped -= 1;
  }

  if (dropped > 0) shown.push(`_…and ${dropped} more_`);

  return shown.length > 0 ? shown.join('\n') : '_none_';
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The reminder DM.
 *
 * Written to be actionable rather than threatening: it says what to do, where,
 * and exactly how long is left.
 */
function warningMessage({ guildName, daysLeft, roleChannelId }) {
  const where = roleChannelId
    ? `head to <#${roleChannelId}> and pick your roles`
    : 'pick your roles in the server';

  return (
    `👋 You joined **${guildName}** a little while ago but have not selected any roles yet.\n\n` +
    `Please ${where} — it only takes a moment.\n\n` +
    `If no roles are selected within **${plural(daysLeft, 'day')}**, you will be removed from the ` +
    'server automatically. You are welcome to rejoin at any time.'
  );
}

/** The DM sent as someone is removed. Must be sent BEFORE the kick. */
function kickMessage({ guildName, graceDays }) {
  return (
    `You have been removed from **${guildName}** because no roles were selected within ` +
    `${plural(graceDays, 'day')} of joining.\n\n` +
    'This is automatic and is not a ban — you are welcome to rejoin and pick your roles.'
  );
}

/** "Someone#1234 — 8 days, no roles" */
function memberLine(member, suffix = '') {
  const days = Number.isFinite(member.daysInServer) ? `${Math.floor(member.daysInServer)}d` : '?';
  return `• \`${member.tag}\` — ${days} in server${suffix}`;
}

/** The moderator-facing record of a completed sweep. */
function buildSweepEmbed({ kicked = [], warned = [], blocked = [], capped = false, config, dryRun = false }) {
  const acted = kicked.length + warned.length;

  const embed = new EmbedBuilder()
    .setColor(kicked.length > 0 ? COLOR_KICK : warned.length > 0 ? COLOR_WARN : COLOR_QUIET)
    .setTitle(dryRun ? 'Onboarding Sweep — Dry Run' : 'Onboarding Sweep')
    .setDescription(
      acted === 0
        ? 'Nobody was due a reminder or a removal.'
        : `${plural(kicked.length, 'member')} removed, ${plural(warned.length, 'reminder')} sent.` +
          (dryRun ? ' **Nothing actually happened — this was a dry run.**' : '')
    )
    .setTimestamp();

  if (kicked.length > 0) {
    embed.addFields({
      name: `🔨 Removed (${kicked.length})`,
      value: listField(kicked.map(m => memberLine(m, m.dmDelivered ? '' : ', DM undeliverable')))
    });
  }

  if (warned.length > 0) {
    embed.addFields({
      name: `📨 Reminded (${warned.length})`,
      value: listField(warned.map(m => memberLine(m, m.dmDelivered ? '' : ', DM undeliverable')))
    });
  }

  // A blocked kick is the outcome that most needs saying out loud: the bot
  // believes it should have acted and could not.
  if (blocked.length > 0) {
    embed.addFields({
      name: `⚠️ Could not remove (${blocked.length})`,
      value: listField(blocked.map(m => `• \`${m.tag}\` — ${m.reason}`))
    });
  }

  if (capped) {
    embed.addFields({
      name: '🛑 Sweep capped',
      value:
        'More members were due removal than one sweep may remove. The rest will be picked up ' +
        'next time. If this repeats, check the grace period and whether role assignment is working.'
    });
  }

  embed.setFooter({
    text: `Grace ${config.graceDays}d • reminder at ${config.warnAfterDays}d`
  });

  return embed;
}

/** What `/autokick preview` shows: who is at risk, and when. */
function buildPreviewEmbed({ kick, warn, waiting, exempt, config, now = Date.now() }) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_PREVIEW)
    .setTitle('Onboarding Preview')
    .setDescription(
      config.enabled
        ? 'What the next sweep would do. Nothing has been changed by running this.'
        : '⚪ The sweep is **off**, so none of this will happen until it is switched on.'
    );

  embed.addFields(
    { name: 'Would be removed', value: String(kick.length), inline: true },
    { name: 'Would be reminded', value: String(warn.length), inline: true },
    { name: 'Still in grace', value: String(waiting.length), inline: true }
  );

  if (kick.length > 0) {
    embed.addFields({ name: `🔨 Removing (${kick.length})`, value: listField(kick.map(m => memberLine(m))) });
  }

  if (warn.length > 0) {
    embed.addFields({ name: `📨 Reminding (${warn.length})`, value: listField(warn.map(m => memberLine(m))) });
  }

  if (waiting.length > 0) {
    embed.addFields({
      name: `⏳ Still choosing (${waiting.length})`,
      value: listField(
        waiting.map(m => memberLine(m, `, ${plural(daysRemaining(m, config, now) ?? 0, 'day')} left`))
      )
    });
  }

  // The number that explains a surprisingly empty preview.
  const protectedByCutoff = exempt.filter(m => m.reason === 'joined before the sweep was switched on');
  if (protectedByCutoff.length > 0) {
    embed.addFields({
      name: 'Protected by the cutoff',
      value:
        `${plural(protectedByCutoff.length, 'member')} with no roles joined before the sweep was ` +
        'switched on and will never be removed by it.'
    });
  }

  embed.setFooter({
    text: `Grace ${config.graceDays}d • reminder at ${config.warnAfterDays}d`
  });

  return embed;
}

/** Posting an alert must never prevent or undo a sweep, so failures are logged only. */
async function sendAlert({ client, channelId, embed }) {
  if (!channelId) {
    console.warn('⚠️  Onboarding sweep alert not sent: no alert channel configured.');
    return false;
  }

  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel?.isTextBased?.()) {
      console.warn(`⚠️  Onboarding alert channel ${channelId} is not a text channel.`);
      return false;
    }

    await channel.send({ embeds: [embed] });
    return true;
  } catch (err) {
    console.warn(`⚠️  Could not send the onboarding sweep alert: ${err.message}`);
    return false;
  }
}

module.exports = {
  COLOR_KICK,
  COLOR_PREVIEW,
  COLOR_QUIET,
  COLOR_WARN,
  MAX_FIELD_LENGTH,
  MAX_LISTED,
  buildPreviewEmbed,
  buildSweepEmbed,
  kickMessage,
  listField,
  memberLine,
  plural,
  sendAlert,
  warningMessage
};
