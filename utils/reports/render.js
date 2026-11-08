// utils/reports/render.js
// The weekly report, as Discord embeds.
//
// This lives outside commands/ because two callers need identical output: the
// scheduler posting on its own, and `/report now` previewing on demand. Keeping
// it here means the preview cannot drift from the real thing.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const { characterKey } = require('./links');
const { countPeople, splitByDiscord } = require('./membership');
const { discordTimestamp, factionColor, formatNumber, fullCharacterName } = require('../wow');

// Discord's hard limits. Exceeding any of them rejects the whole message, so
// every list is capped rather than trusted to be short.
const MAX_FIELD_LENGTH = 1024;

// How many names each section lists before collapsing into a count. Long enough
// to feel complete for a normal week, short enough to stay readable on a phone.
const MAX_LISTED = 10;

/** "1 person" / "3 people" — the counts read as prose, so they have to agree. */
function countOf(value, singular, plural) {
  return `${formatNumber(value)} ${value === 1 ? singular : plural}`;
}

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
function nameOf(entry, owners) {
  const userId = owners?.get?.(characterKey({ name: entry.name, surname: entry.surname }));
  const name = fullCharacterName(entry);
  return userId ? `**${name}** (<@${userId}>)` : `**${name}**`;
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

/** Just the guild's name — it has no realm. */
function guildLabel(guild) {
  return guild?.name ?? '';
}

function membershipLines(entries, owners) {
  return entries.map(entry => {
    const detail = [entry.className, entry.level ? `level ${entry.level}` : null]
      .filter(Boolean)
      .join(', ');
    return `${nameOf(entry, owners)}${detail ? ` — ${detail}` : ''}`;
  });
}

function levelLines(entries, owners) {
  return entries.map(entry => {
    const arrow = `${entry.from} → ${entry.to}`;
    return `${nameOf(entry, owners)} — ${arrow}${entry.cappedOut ? ' 🎉' : ''}`;
  });
}

function rankLines(entries, owners) {
  return entries.map(entry => `${nameOf(entry, owners)} — rank ${entry.from} → ${entry.to}`);
}

function killLines(entries, owners) {
  return entries.map(
    entry =>
      `${nameOf(entry, owners)} — **+${formatNumber(entry.change)}** (${formatNumber(
        entry.total
      )} total)`
  );
}

/**
 * Top gainers from today's kill tally, for the headline embed. The full
 * lifetime/7-day/today figures for everyone are a button press away — this
 * is only the "something happened today" teaser.
 */
function killTallySummaryLines(tally, owners = new Map(), { max = 5 } = {}) {
  return tally
    .filter(entry => Number.isFinite(entry.today) && entry.today > 0)
    .slice(0, max)
    .map(entry => `${nameOf(entry, owners)} — **+${formatNumber(entry.today)}**`);
}

const ROSTER_BUTTON_PREFIX = 'report:roster:';
const KILL_TALLY_BUTTON_PREFIX = 'report:kills:';

/**
 * A button per guild, sending the full Discord breakdown by DM.
 *
 * One message can carry several guilds' reports, and components belong to a
 * message rather than an embed, so each button names its guild. Discord allows
 * five buttons per row and the tracked-guild ceiling is ten, hence the split.
 */
function buildRosterComponents(guilds) {
  const rows = [];

  for (let index = 0; index < guilds.length; index += 5) {
    const row = new ActionRowBuilder().addComponents(
      guilds.slice(index, index + 5).map(guild =>
        new ButtonBuilder()
          .setCustomId(`${ROSTER_BUTTON_PREFIX}${guild.key}`)
          .setLabel(
            guilds.length === 1 ? 'Who is on Discord?' : `${guild.name}: who is on Discord?`.slice(0, 80)
          )
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🔗')
      )
    );

    rows.push(row);
  }

  return rows;
}

/**
 * A second button per guild, DMing the full honorable-kill tally: lifetime,
 * the last 7 days, and today, for every member with kill data. Kept separate
 * from the roster button rather than folded into one, because Discord allows
 * five buttons per row and up to ten tracked guilds already need two rows for
 * the roster alone.
 */
function buildKillTallyComponents(guilds) {
  const rows = [];

  for (let index = 0; index < guilds.length; index += 5) {
    const row = new ActionRowBuilder().addComponents(
      guilds.slice(index, index + 5).map(guild =>
        new ButtonBuilder()
          .setCustomId(`${KILL_TALLY_BUTTON_PREFIX}${guild.key}`)
          .setLabel(
            guilds.length === 1 ? 'Kill tally' : `${guild.name}: kill tally`.slice(0, 80)
          )
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('💀')
      )
    );

    rows.push(row);
  }

  return rows;
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
 * What to call the kill tally's most-recent-capture column.
 *
 * Kill-history is captured once per report, not on its own daily clock (see
 * the note on buildGuildReport in scheduler.js) — so on a weekly cadence that
 * figure covers a week, not a day. Shared by the report embed and the kill
 * tally DM so the two never disagree about what the number means.
 */
function killTallyPeriodLabel(frequency) {
  return frequency === 'weekly' ? 'This Week' : 'Today';
}

/**
 * One guild's report.
 *
 * @param {object} diff     From diffSnapshots.
 * @param {Map}    owners   Character key -> Discord user id, from buildOwnerIndex.
 * @param {string[]} warnings  Anything the collector could not fetch.
 * @param {object[]} killTally  From buildKillTally — the most-recent-capture
 *   gain, the 7-day gain, and lifetime honorable kills per member.
 * @param {string} frequency  This guild's report cadence ('daily' or
 *   'weekly'); see killTallyPeriodLabel.
 */
function buildReportEmbed({
  diff,
  owners = new Map(),
  warnings = [],
  presentUserIds = null,
  killTally = [],
  frequency = 'daily'
}) {
  const killTallyPeriod = killTallyPeriodLabel(frequency);
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
    }
  );

  // Headline numbers only. Who they actually are is a button press away, so the
  // report does not turn into a wall of names.
  const split = splitByDiscord(diff.members ?? [], owners, presentUserIds);
  const people = countPeople(split);

  if (diff.members?.length > 0) {
    // People and characters are different units and are labelled as such: alts
    // collapse into one person, but an unclaimed character cannot be collapsed
    // into anything, because nobody knows whose it is.
    embed.addFields(
      { name: '🟢 On Discord', value: countOf(people.onDiscord, 'person', 'people'), inline: true },
      {
        name: '⚪ Unclaimed',
        value: countOf(people.unidentified, 'character', 'characters'),
        inline: true
      },
      {
        name: people.left > 0 ? '🚪 Left Discord' : '​',
        value: people.left > 0 ? countOf(people.left, 'person', 'people') : '​',
        inline: true
      }
    );
  }

  addList(embed, `📥 Joined (${diff.joined.length})`, membershipLines(diff.joined, owners));
  addList(embed, `📤 Left (${diff.left.length})`, membershipLines(diff.left, owners));
  addList(embed, `⬆️ Level-ups (${diff.levelUps.length})`, levelLines(diff.levelUps, owners));
  addList(embed, `🎖️ Promotions (${diff.promotions.length})`, rankLines(diff.promotions, owners));
  addList(embed, '💀 Honorable Kills', killLines(diff.kills, owners));
  addList(embed, `📅 Most Kills ${killTallyPeriod}`, killTallySummaryLines(killTally, owners));

  // A quiet week is a real result, and saying so beats an embed of bare totals
  // that looks like something failed.
  const hasContent =
    diff.joined.length +
      diff.left.length +
      diff.levelUps.length +
      diff.promotions.length +
      diff.kills.length +
      killTallySummaryLines(killTally, owners).length >
    0;

  if (!hasContent && !diff.isFirstRun) {
    embed.addFields({
      name: 'Quiet week',
      value: 'No roster changes, and no honorable kills recorded.'
    });
  }

  if (warnings.length > 0) {
    embed.addFields({ name: '⚠️ Incomplete', value: listField(warnings, { max: 5 }) });
  }

  const captured = discordTimestamp(diff.capturedAt, 'f');
  embed.setFooter({ text: `${diff.guild?.region?.toUpperCase?.() ?? ''}`.trim() });

  if (captured) embed.setTimestamp(new Date(diff.capturedAt));

  return embed;
}

module.exports = {
  KILL_TALLY_BUTTON_PREFIX,
  ROSTER_BUTTON_PREFIX,
  MAX_FIELD_LENGTH,
  MAX_LISTED,
  buildKillTallyComponents,
  buildReportEmbed,
  buildRosterComponents,
  countOf,
  describePeriod,
  formatChange,
  guildLabel,
  killLines,
  killTallyPeriodLabel,
  killTallySummaryLines,
  levelLines,
  listField,
  membershipLines,
  nameOf,
  rankLines
};
