// utils/reports/render.js
// The weekly report, as Discord embeds.
//
// This lives outside commands/ because two callers need identical output: the
// scheduler posting on its own, and `/report now` previewing on demand. Keeping
// it here means the preview cannot drift from the real thing.

const { EmbedBuilder } = require('discord.js');

const { characterKey } = require('./links');
const { discordTimestamp, factionColor, formatNumber } = require('../wow');

// Discord's hard limits. Exceeding any of them rejects the whole message, so
// every list is capped rather than trusted to be short.
const MAX_FIELD_LENGTH = 1024;

// How many names each section lists before collapsing into a count. Long enough
// to feel complete for a normal week, short enough to stay readable on a phone.
const MAX_LISTED = 10;
const MAX_LADDER_LISTED = 5;

/** "+150" / "-20"; zero is not worth printing as a change. */
function formatChange(value) {
  if (!Number.isFinite(value) || value === 0) return null;
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

/**
 * A character's name, upgraded to include a Discord mention when the person has
 * linked it with /iam. Reports work fine with nobody linked — that is the point
 * of building them from the roster rather than from registrations.
 */
function nameOf(entry, realmSlug, owners) {
  const userId = owners?.get?.(characterKey({ name: entry.name, realm: realmSlug }));
  return userId ? `**${entry.name}** (<@${userId}>)` : `**${entry.name}**`;
}

/**
 * Joins lines into one field value, trimming to fit and saying how many were
 * dropped. Truncation happens on BOTH counts and characters: ten short names
 * fit easily, ten long ones with mentions may not.
 */
function listField(lines, { max = MAX_LISTED } = {}) {
  const shown = [];
  let length = 0;
  let dropped = lines.length;

  for (const line of lines.slice(0, max)) {
    // Reserve room for the "and N more" footer that may follow.
    if (length + line.length + 1 > MAX_FIELD_LENGTH - 40) break;
    shown.push(line);
    length += line.length + 1;
    dropped -= 1;
  }

  if (dropped > 0) shown.push(`_…and ${formatNumber(dropped)} more_`);

  return shown.join('\n');
}

function addList(embed, name, lines, options) {
  if (lines.length === 0) return;
  embed.addFields({ name, value: listField(lines, options) });
}

/** "Apex · Nightslayer" — the guild line under the title. */
function guildLabel(guild) {
  return [guild?.name, guild?.realm].filter(Boolean).join(' · ');
}

function membershipLines(entries, realmSlug, owners) {
  return entries.map(entry => {
    const detail = [entry.className, entry.level ? `level ${entry.level}` : null]
      .filter(Boolean)
      .join(', ');
    return `${nameOf(entry, realmSlug, owners)}${detail ? ` — ${detail}` : ''}`;
  });
}

function levelLines(entries, realmSlug, owners) {
  return entries.map(entry => {
    const arrow = `${entry.from} → ${entry.to}`;
    return `${nameOf(entry, realmSlug, owners)} — ${arrow}${entry.cappedOut ? ' 🎉' : ''}`;
  });
}

function rankLines(entries, realmSlug, owners) {
  return entries.map(
    entry => `${nameOf(entry, realmSlug, owners)} — rank ${entry.from} → ${entry.to}`
  );
}

/**
 * "`#22` **Butud** — 1950 (+150) · 20W/7L"
 *
 * On a first run every entry is technically new, so the "(new)" marker is
 * suppressed — it means "started playing this bracket this week", which is only
 * true once there is a previous week.
 */
function ladderLines(entries, realmSlug, owners, { isFirstRun = false } = {}) {
  return entries.map(entry => {
    const rank = entry.rank === null ? '' : `\`#${formatNumber(entry.rank)}\` `;
    const change = isFirstRun ? null : entry.isNew ? 'new' : formatChange(entry.ratingChange);
    const record = `${entry.won}W/${entry.lost}L`;

    return `${rank}${nameOf(entry, realmSlug, owners)} — ${formatNumber(entry.rating)}${
      change ? ` (${change})` : ''
    } · ${record}`;
  });
}

function killLines(entries, realmSlug, owners) {
  return entries.map(
    entry =>
      `${nameOf(entry, realmSlug, owners)} — **+${formatNumber(entry.change)}** (${formatNumber(
        entry.total
      )} total)`
  );
}

/** The period the report covers, or an explanation of why there is no period. */
function describePeriod(diff) {
  if (diff.isFirstRun) {
    return (
      'First report for this guild — there is no earlier snapshot to compare against, ' +
      'so this is a starting position. Next week will show what changed.'
    );
  }

  const since = discordTimestamp(diff.previousAt, 'R');
  return since ? `Changes since the last report, ${since}.` : 'Changes since the last report.';
}

/**
 * One guild's report.
 *
 * @param {object} diff     From diffSnapshots.
 * @param {Map}    owners   Character key -> Discord user id, from buildOwnerIndex.
 * @param {string[]} warnings  Anything the collector could not fetch.
 */
function buildReportEmbed({ diff, owners = new Map(), warnings = [] }) {
  const realmSlug = diff.guild?.realmSlug ?? diff.guild?.realm;

  const embed = new EmbedBuilder()
    .setColor(factionColor(diff.guild?.faction))
    .setTitle(`Weekly Report — ${guildLabel(diff.guild)}`)
    .setDescription(describePeriod(diff));

  embed.addFields(
    { name: 'Members', value: formatNumber(diff.totals.members), inline: true },
    {
      name: diff.maxLevel === null ? 'At Max Level' : `At Level ${diff.maxLevel}`,
      value: formatNumber(diff.totals.atMaxLevel),
      inline: true
    },
    { name: 'Arena Ranked', value: formatNumber(diff.totals.ranked), inline: true }
  );

  addList(embed, `📥 Joined (${diff.joined.length})`, membershipLines(diff.joined, realmSlug, owners));
  addList(embed, `📤 Left (${diff.left.length})`, membershipLines(diff.left, realmSlug, owners));
  addList(embed, `⬆️ Level-ups (${diff.levelUps.length})`, levelLines(diff.levelUps, realmSlug, owners));
  addList(embed, `🎖️ Promotions (${diff.promotions.length})`, rankLines(diff.promotions, realmSlug, owners));

  for (const bracket of diff.arena) {
    embed.addFields({
      name: `⚔️ ${bracket.bracket} (${bracket.entries.length} ranked)`,
      value: listField(ladderLines(bracket.entries, realmSlug, owners, { isFirstRun: diff.isFirstRun }), {
        max: MAX_LADDER_LISTED
      })
    });
  }

  addList(embed, '💀 Honorable Kills', killLines(diff.kills, realmSlug, owners));

  // A quiet week is a real result, and saying so beats an embed of bare totals
  // that looks like something failed.
  const hasContent =
    diff.joined.length +
      diff.left.length +
      diff.levelUps.length +
      diff.promotions.length +
      diff.arena.length +
      diff.kills.length >
    0;

  if (!hasContent && !diff.isFirstRun) {
    embed.addFields({
      name: 'Quiet week',
      value: 'No roster changes, no ladder movement, and no honorable kills recorded.'
    });
  }

  if (warnings.length > 0) {
    embed.addFields({ name: '⚠️ Incomplete', value: listField(warnings, { max: 5 }) });
  }

  const captured = discordTimestamp(diff.capturedAt, 'f');
  embed.setFooter({
    text: [
      diff.guild?.seasonId ? `Season ${diff.guild.seasonId}` : null,
      `${diff.guild?.region?.toUpperCase?.() ?? ''}`.trim() || null
    ]
      .filter(Boolean)
      .join(' • ')
  });

  if (captured) embed.setTimestamp(new Date(diff.capturedAt));

  return embed;
}

module.exports = {
  MAX_FIELD_LENGTH,
  MAX_LADDER_LISTED,
  MAX_LISTED,
  buildReportEmbed,
  describePeriod,
  formatChange,
  guildLabel,
  killLines,
  ladderLines,
  levelLines,
  listField,
  membershipLines,
  nameOf,
  rankLines
};
