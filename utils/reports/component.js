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
//
// EVERYBODY is listed, on both sides — nothing is trimmed to "and 90 more",
// because the whole point is to work through the list. A guild roster does not
// fit in one embed, so it spills across fields, then embeds, then messages, and
// the sections that are just names are laid out as columns to keep it short
// enough to actually read.

const { EmbedBuilder, MessageFlags } = require('discord.js');

const { packFields, packIntoMessages, toFields } = require('../embeds');
const { loadSnapshot } = require('./history');
const { buildOwnerIndex, mainFor } = require('./links');
const { countPeople, discordOnly, rosterUserIds, splitByDiscord } = require('./membership');
const { ROSTER_BUTTON_PREFIX } = require('./render');
const { FALLBACK_COLOR } = require('../wow');

// Three inline fields sit side by side in Discord, so capping a column at a
// dozen lines produces a readable three-column block rather than one very long
// stripe down the page.
const COLUMN_LINES = 12;

/** "1 person" / "3 people" */
function countOf(value, singular, plural) {
  return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * A full-width section: one line per entry.
 *
 * Used where the line carries real structure — an account and its characters —
 * which would wrap badly in a narrow column.
 */
function blockSection(label, lines) {
  return toFields(label, lines);
}

/** A three-column section, for lists that are only names. */
function columnSection(label, lines) {
  return toFields(label, lines, { inline: true, maxLines: COLUMN_LINES });
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

/** The summary at the top of the first message. */
function buildSummary(guild, split) {
  const people = countPeople(split);

  return [
    `**${countOf(people.onDiscord, 'person', 'people')}** on Discord, ` +
      `playing ${countOf(split.onDiscord.length, 'character', 'characters')}.`,
    `**${countOf(people.unidentified, 'character', 'characters')}** on the roster ` +
      `${people.unidentified === 1 ? 'is' : 'are'} claimed by nobody.`,
    people.left > 0
      ? `**${countOf(people.left, 'person', 'people')}** linked here but no longer in the server.`
      : null
  ]
    .filter(Boolean)
    .join('\n');
}

/** Every field the breakdown needs, in reading order. */
function buildFields({ split, outsiders, resolveMain }) {
  const people = countPeople(split);

  return [
    // Accounts and their characters: structured, so full width.
    ...blockSection(
      `🟢 On Discord (${countOf(people.onDiscord, 'person', 'people')})`,
      personLines(split.onDiscord, { resolveMain })
    ),
    ...blockSection(
      `🚪 Linked, but left the server (${countOf(people.left, 'person', 'people')})`,
      personLines(split.left, { resolveMain })
    ),
    // Just names: columns, because there are usually a great many.
    ...columnSection(
      `⚪ Claimed by nobody — chase these (${split.unlinked.length})`,
      unclaimedLines(split.unlinked)
    ),
    ...columnSection(
      `👋 In Discord, no character here (${outsiders.length})`,
      outsiders.map(member => `<@${member.id}>`)
    ),
    ...(split.unlinked.length > 0
      ? [
          {
            // The honest caveat: an unclaimed character is not proof of absence.
            name: 'Why "claimed by nobody" is not "not here"',
            value:
              'The bot can only connect a character to an account when somebody claims it ' +
              'with `/iam add`, or an admin assigns it with `/iam manage assign`. Anyone ' +
              'above may already be in the server — assigning their character is what turns ' +
              'a guess into a name.',
            inline: false
          }
        ]
      : [])
  ];
}

/**
 * The whole breakdown, as however many messages it takes.
 *
 * @returns {object[][]} one array of embeds per message to send.
 */
function buildBreakdownMessages({ guild, split, outsiders = [], resolveMain = mainFor }) {
  const title = `${guild?.name ?? 'Guild'} — who is on Discord`;
  const fields = buildFields({ split, outsiders, resolveMain });

  // Title and summary are added below, after the fields are packed, so their
  // length has to be held back from the per-embed budget.
  const reserve = title.length + 20 + buildSummary(guild, split).length;

  const embeds = packFields(fields, (chunk, index) => {
    const embed = new EmbedBuilder()
      .setColor(FALLBACK_COLOR)
      .setTitle(index === 0 ? title : `${title} — continued`)
      .addFields(chunk);

    // The summary belongs on the first embed only; repeating it would read as
    // a second, contradictory report.
    if (index === 0) embed.setDescription(buildSummary(guild, split));

    return embed;
  }, { reserve });

  return packIntoMessages(embeds);
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
  const messages = buildBreakdownMessages({ guild: snapshot.guild, split, outsiders });

  try {
    for (const embeds of messages) await interaction.user.send({ embeds });

    await interaction.editReply(
      `📬 Sent you the breakdown by DM${messages.length > 1 ? ` — ${messages.length} messages` : ''}.`
    );
  } catch {
    // DMs closed is common enough that falling back beats failing. The reply
    // takes the first message and follow-ups carry the rest, so nothing is
    // lost just because somebody keeps their DMs shut.
    const [first, ...rest] = messages;

    await interaction.editReply({
      content: '⚠️ I could not DM you, so here it is instead.',
      embeds: first ?? []
    });

    for (const embeds of rest) {
      await interaction.followUp({ embeds, flags: MessageFlags.Ephemeral });
    }
  }

  return true;
}

module.exports = {
  COLUMN_LINES,
  blockSection,
  buildBreakdownMessages,
  buildFields,
  buildSummary,
  columnSection,
  countOf,
  groupByOwner,
  handleComponent,
  personLines,
  unclaimedLines
};
