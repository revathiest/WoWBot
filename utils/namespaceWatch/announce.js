// utils/namespaceWatch/announce.js
// Turning a set of state changes into a message in the activity-log channel.
//
// This is the only file here that touches discord.js, which keeps `checks.js`,
// `probe.js` and `store.js` testable without a client.

const { EmbedBuilder } = require('discord.js');

const { BY_KEY, WATCHED_GAME, isArrival, isRegression } = require('./checks');
const { isGuildInScope } = require('../guildScope');

// Discord snowflakes are 17-19 digits. Anything else is treated as a name.
const SNOWFLAKE = /^\d{17,20}$/;

const COLOURS = {
  arrival: 0x2ecc71,
  regression: 0xe74c3c,
  mixed: 0xf1c40f
};

const STATE_ICONS = {
  available: '🟢',
  empty: '🟡',
  pending: '⚪',
  rejected: '🔴',
  blocked: '⏸️',
  skipped: '⏭️',
  error: '⚠️'
};

const STATE_WORDS = {
  available: 'live',
  // Distinct from `pending`: the endpoint answers, but the collection behind it
  // holds nothing. `/data/wow/search/realm` does exactly this on Forever.
  empty: 'answering, but with no rows',
  pending: 'accepted but empty (404)',
  rejected: 'namespace refused (403)',
  blocked: 'not polled yet',
  skipped: 'not polled — nothing configured to test it with',
  error: 'could not be reached'
};

/**
 * Finds the channel to post in.
 *
 * Accepts an id or a name. A name is searched across the guilds this instance
 * actually serves, so a pinned deployment cannot post into somebody else's
 * server — the same protection `publishReports` applies for the same reason.
 */
async function resolveChannel(client, { channel, guildId = null } = {}) {
  const target = String(channel ?? '').trim().replace(/^#/, '');
  if (!target) return null;

  if (SNOWFLAKE.test(target)) {
    try {
      const found = await client.channels.fetch(target);

      if (!found?.isTextBased?.()) return null;
      if (!isGuildInScope(found.guildId, guildId)) return null;

      return found;
    } catch {
      return null;
    }
  }

  const wanted = target.toLowerCase();

  for (const guild of client.guilds?.cache?.values?.() ?? []) {
    if (!isGuildInScope(guild.id, guildId)) continue;

    const found = guild.channels?.cache?.find?.(
      candidate => candidate?.isTextBased?.() && candidate.name?.toLowerCase() === wanted
    );

    if (found) return found;
  }

  return null;
}

function describeChange(change) {
  const check = BY_KEY.get(change.key);
  const label = check?.label ?? change.key;
  const icon = STATE_ICONS[change.to] ?? STATE_ICONS.error;

  const from = STATE_WORDS[change.from] ?? 'not seen before';
  const to = STATE_WORDS[change.to] ?? change.to;

  const lines = [`${from} → **${to}**`];

  if (check?.unlocks) lines.push(`Unlocks: ${check.unlocks}`);

  // Said plainly, because a green tick next to this one would overstate it.
  if (check?.needsCharacter && change.to !== 'available') {
    lines.push(
      '⚠️ Checked with the configured probe character — confirm it still exists ' +
        'before blaming the API.'
    );
  }

  return { name: `${icon} ${label}`, value: lines.join('\n'), inline: false };
}

/**
 * Builds the announcement.
 *
 * Returns null when there is nothing to say, so the caller never has to decide
 * whether an empty change list is postable.
 */
function buildAnnouncement({
  changes = [],
  patch = null,
  patchChanged = false,
  region = 'us',
  regionName = null
} = {}) {
  if (changes.length === 0 && !patchChanged) return null;

  const arrivals = changes.filter(change => isArrival(change.from, change.to));
  const regressions = changes.filter(change => isRegression(change.from, change.to));

  const colour = arrivals.length > 0 && regressions.length === 0
    ? COLOURS.arrival
    : regressions.length > 0 && arrivals.length === 0
      ? COLOURS.regression
      : COLOURS.mixed;

  const title = arrivals.length > 0
    ? `🟢 \`${WATCHED_GAME}\` namespace: ${arrivals.length} endpoint(s) came online`
    : regressions.length > 0
      ? `🔴 \`${WATCHED_GAME}\` namespace: ${regressions.length} endpoint(s) stopped answering`
      : `ℹ️ \`${WATCHED_GAME}\` namespace changed`;

  const embed = new EmbedBuilder()
    .setColor(colour)
    .setTitle(title)
    .setTimestamp(new Date());

  const description = [
    `Namespaces: \`static-${WATCHED_GAME}-${region}\`, \`dynamic-${WATCHED_GAME}-${region}\`, ` +
      `\`profile-${WATCHED_GAME}-${region}\``
  ];

  if (patch) {
    description.push(
      patchChanged ? `Patch: **${patch}** (changed)` : `Patch: ${patch}`
    );
  }

  // Worth showing: while this still reads "CAMWOW", the namespace is an internal
  // realm group rather than anything players can log in to.
  if (regionName) description.push(`Region: ${regionName}`);

  if (arrivals.some(change => change.key === 'dynamic.realm-index')) {
    description.push(
      '\n**The realm index is live.** That was the blocker — `forever` can now be ' +
        'promoted from `PENDING_GAMES` to `GAMES` in `config/index.js`, which is the ' +
        'one-line change that exposes it as a `game` choice.'
    );
  }

  embed.setDescription(description.join('\n'));

  // Ten fields keeps the embed readable; there are only nine checks, so this is
  // a guard rather than a routine truncation.
  for (const change of changes.slice(0, 10)) {
    const field = describeChange(change);
    embed.addFields(field);
  }

  if (changes.length > 10) {
    embed.addFields({ name: '…', value: `and ${changes.length - 10} more`, inline: false });
  }

  return embed;
}

/**
 * Posts the announcement. Never throws — a watcher that crashes the ready
 * handler is worse than one that misses a notice.
 */
async function announce(client, embed, { channel, guildId = null } = {}) {
  if (!embed) return { posted: false, reason: 'nothing to announce' };

  const target = await resolveChannel(client, { channel, guildId });

  if (!target) {
    console.warn(
      `⚠️  namespace watch: could not find a channel called "${channel}" in any guild in scope.`
    );
    return { posted: false, reason: 'channel not found' };
  }

  try {
    await target.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return { posted: true, channelId: target.id };
  } catch (err) {
    console.warn(`⚠️  namespace watch: could not post to ${target.id} — ${err.message}`);
    return { posted: false, reason: err.message };
  }
}

module.exports = {
  COLOURS,
  SNOWFLAKE,
  STATE_ICONS,
  STATE_WORDS,
  announce,
  buildAnnouncement,
  describeChange,
  resolveChannel
};
