// utils/spam/alert.js
// The moderator-facing record of every enforcement decision. With no database,
// this channel IS the audit trail, so it carries everything needed to review a
// decision after the fact: who, what, why, and the offending text.

const { EmbedBuilder } = require('discord.js');
const { formatNumber } = require('../wow');

const COLOR_BAN = 0xff2222;
const COLOR_TIMEOUT = 0xff8c00;
const COLOR_BLOCKED = 0x9d9d9d;

const MAX_CONTENT_CHARS = 1024;

/** "1h", "45m", "2h 30m" */
function formatDuration(ms) {
  const totalMinutes = Math.max(Math.round(Number(ms) / 60000), 0);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}

function truncate(value, max = MAX_CONTENT_CHARS) {
  const text = String(value ?? '').trim();
  if (!text) return '*(no text content)*';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeAction({ action, durationMs, acted, blockedReason }) {
  if (!acted) return `⚠️ No action — ${blockedReason}`;
  return action === 'ban' ? '🔨 Banned' : `⏱️ Timed out (${formatDuration(durationMs)})`;
}

/**
 * Builds the alert embed.
 *
 * @param {object} input
 * @param {object} input.message   The offending message.
 * @param {object} input.member    The member acted on.
 * @param {object} input.decision  From detector.decide(), plus `reason`.
 * @param {object} input.outcome   From enforcement.act().
 * @param {string} input.tier      Trust tier.
 * @param {string[]} input.signals Red flags that fired.
 */
function buildAlertEmbed({ message, member, decision, outcome, tier, signals, accountAge, tenure }) {
  const color = !outcome.acted
    ? COLOR_BLOCKED
    : decision.action === 'ban'
      ? COLOR_BAN
      : COLOR_TIMEOUT;

  const user = member?.user ?? message.author;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(decision.verdict === 'compromise' ? 'Possible Account Compromise' : 'Spam Detected')
    .addFields(
      { name: 'User', value: `<@${user.id}> (${user.tag ?? user.username ?? user.id})`, inline: true },
      {
        name: 'Action',
        value: describeAction({
          action: decision.action,
          durationMs: decision.durationMs,
          acted: outcome.acted,
          blockedReason: outcome.blockedReason
        }),
        inline: true
      },
      { name: 'Channel', value: `<#${message.channel?.id ?? message.channelId}>`, inline: true },
      { name: 'Account Age', value: `${formatNumber(accountAge)} day(s)`, inline: true },
      { name: 'In Server', value: `${formatNumber(tenure)} day(s)`, inline: true },
      { name: 'Trust Tier', value: tier, inline: true },
      { name: 'Message Deleted', value: outcome.deleted ? 'Yes' : 'No', inline: true },
      { name: `Red Flags (${signals.length})`, value: signals.map(s => `• ${s}`).join('\n') },
      { name: 'Message', value: truncate(message.content) }
    )
    .setTimestamp();
}

/**
 * Posts the alert. A misconfigured channel must never prevent enforcement, so
 * every failure here is logged and swallowed.
 */
async function sendAlert({ client, channelId, embed }) {
  if (!channelId) {
    console.warn('⚠️  Spam alert not sent: no alert channel configured.');
    return false;
  }

  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel?.isTextBased?.()) {
      console.warn(`⚠️  Spam alert channel ${channelId} is not a text channel.`);
      return false;
    }

    await channel.send({ embeds: [embed] });
    return true;
  } catch (err) {
    console.warn(`⚠️  Could not send spam alert: ${err.message}`);
    return false;
  }
}

module.exports = {
  COLOR_BAN,
  COLOR_BLOCKED,
  COLOR_TIMEOUT,
  MAX_CONTENT_CHARS,
  buildAlertEmbed,
  describeAction,
  formatDuration,
  sendAlert,
  truncate
};
