// utils/reports/component.js
// The "who is on Discord?" button under each report.
//
// The report itself carries only the headline counts, because a list of two
// hundred names would bury everything else in it. Pressing the button sends the
// full breakdown as a DM — private, as long as the reader wants, and it does
// not clutter the channel that gets wiped before each post.
//
// The breakdown is grouped by PERSON, not listed as characters, because that is
// the question being asked. "Butud, Alt, Banker, Mindbugger" says nothing about
// how many people that is, or whose they are; one line per account, main in
// bold and alts after it, answers both at a glance.

const { EmbedBuilder, MessageFlags } = require('discord.js');

const { loadSnapshot } = require('./history');
const { buildOwnerIndex, mainFor } = require('./links');
const { countPeople, discordOnly, rosterUserIds, splitByDiscord } = require('./membership');
const { ROSTER_BUTTON_PREFIX } = require('./render');
const { FALLBACK_COLOR } = require('../wow');

const MAX_FIELD_LENGTH = 1024;

// A DM long enough to scroll is fine; one long enough to give up on is not.
const MAX_FIELDS_PER_GROUP = 3;
const MAX_LINES_PER_GROUP = 20;

/** "1 person" / "3 people" */
function countOf(value, singular, plural) {
  return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * Packs lines into field-sized chunks.
 *
 * Both limits matter: Discord rejects a field over 1024 characters, and a
 * reader gives up well before that many names anyway, so whichever runs out
 * first wins and the remainder becomes a count.
 */
function packLines(label, lines, { emoji = '', total = null } = {}) {
  if (lines.length === 0) return [];

  const capped = lines.slice(0, MAX_LINES_PER_GROUP);
  let dropped = lines.length - capped.length;

  const fields = [];
  let current = [];
  let length = 0;

  // Room for the "…and N more" that may be appended to the last chunk.
  const limit = MAX_FIELD_LENGTH - 60;

  for (const [index, line] of capped.entries()) {
    if (current.length > 0 && length + line.length + 1 > limit) {
      if (fields.length + 1 >= MAX_FIELDS_PER_GROUP) {
        dropped += capped.length - index;
        break;
      }

      fields.push(current);
      current = [];
      length = 0;
    }

    current.push(line);
    length += line.length + 1;
  }

  if (current.length > 0) fields.push(current);
  if (dropped > 0) fields[fields.length - 1].push(`_…and ${dropped} more_`);

  return fields.map((chunk, index) => ({
    name: index === 0 ? `${emoji} ${label} (${total ?? lines.length})` : `${label} — continued`,
    value: chunk.join('\n')
  }));
}

/**
 * Groups characters by the account that owns them, main first.
 *
 * The main comes from the links file rather than the roster, since a guild
 * roster has no idea which character somebody answers to.
 */
function groupByOwner(characters, { resolveMain = mainFor } = {}) {
  const owners = new Map();

  for (const character of characters) {
    owners.set(character.userId, [...(owners.get(character.userId) ?? []), character]);
  }

  return [...owners.entries()].map(([userId, owned]) => {
    const mainName = resolveMain(userId)?.name?.toLowerCase();

    // Main first, then the rest by level — the order somebody would read them
    // out in.
    const sorted = [...owned].sort((a, b) => {
      if (a.name.toLowerCase() === mainName) return -1;
      if (b.name.toLowerCase() === mainName) return 1;
      return (b.level ?? 0) - (a.level ?? 0);
    });

    return { userId, characters: sorted };
  });
}

/** "<@111> — **Butud** · Alt, Banker" */
function personLines(characters, options = {}) {
  return groupByOwner(characters, options)
    // Whoever has the most characters first: those are the lines that carry
    // the most information.
    .sort((a, b) => b.characters.length - a.characters.length)
    .map(({ userId, characters: owned }) => {
      const [main, ...alts] = owned;
      const rest = alts.length > 0 ? ` · ${alts.map(character => character.name).join(', ')}` : '';

      return `<@${userId}> — **${main.name}**${rest}`;
    });
}

/**
 * Unclaimed characters, the ones worth chasing first.
 *
 * Sorted by level, because a level 70 nobody can reach matters and a level 1
 * bank alt does not. The class is included where the roster knew it.
 */
function unclaimedLines(characters) {
  return [...characters]
    .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
    .map(character => {
      const level = Number.isFinite(character.level)
        ? `\`${String(character.level).padStart(2)}\` `
        : '';
      const className = character.className ? ` · ${character.className}` : '';

      return `${level}**${character.name}**${className}`;
    });
}

/** The DM. */
function buildBreakdownEmbed({ guild, split, outsiders = [], resolveMain = mainFor }) {
  const people = countPeople(split);

  const embed = new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle(`${guild?.name ?? 'Guild'} — who is on Discord`)
    .setDescription(
      [
        `**${countOf(people.onDiscord, 'person', 'people')}** on Discord, ` +
          `playing ${countOf(split.onDiscord.length, 'character', 'characters')}.`,
        `**${countOf(people.unidentified, 'character', 'characters')}** on the roster ` +
          `${people.unidentified === 1 ? 'is' : 'are'} claimed by nobody.`
      ].join('\n')
    );

  embed.addFields(
    ...packLines('On Discord', personLines(split.onDiscord, { resolveMain }), {
      emoji: '🟢',
      total: countOf(people.onDiscord, 'person', 'people')
    }),
    ...packLines('Linked, but left the server', personLines(split.left, { resolveMain }), {
      emoji: '🚪',
      total: countOf(people.left, 'person', 'people')
    }),
    ...packLines('Claimed by nobody — chase these', unclaimedLines(split.unlinked), { emoji: '⚪' })
  );

  if (outsiders.length > 0) {
    embed.addFields(
      ...packLines(
        'In Discord, no character here',
        outsiders.map(member => `<@${member.id}>`),
        { emoji: '👋' }
      )
    );
  }

  if (split.unlinked.length > 0) {
    // The honest caveat: an unclaimed character is not proof of absence.
    embed.addFields({
      name: 'Why "claimed by nobody" is not "not here"',
      value:
        'The bot can only connect a character to an account when somebody claims it with ' +
        '`/iam add`, or an admin assigns it with `/iam manage assign`. Anyone above may already ' +
        'be in the server — assigning their character is what turns a guess into a name.'
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

  // The full member list is needed twice: to tell a departed account from a
  // present one, and to find people in the server with no roster character.
  let serverMembers = null;
  try {
    serverMembers = interaction.guild ? await interaction.guild.members.fetch() : null;
  } catch (err) {
    console.warn(`⚠️  reports: could not read the member list — ${err.message}`);
  }

  const presentUserIds = serverMembers ? new Set([...serverMembers.keys()]) : null;
  const split = splitByDiscord(members, realmSlug, buildOwnerIndex(), presentUserIds);

  const outsiders = serverMembers ? discordOnly(serverMembers.values(), rosterUserIds(split)) : [];
  const embed = buildBreakdownEmbed({ guild: snapshot.guild, split, outsiders });

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

module.exports = {
  MAX_FIELDS_PER_GROUP,
  MAX_LINES_PER_GROUP,
  buildBreakdownEmbed,
  countOf,
  groupByOwner,
  handleComponent,
  packLines,
  personLines,
  unclaimedLines
};
