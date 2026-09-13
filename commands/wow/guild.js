// commands/wow/guild.js
// /guild — roster summary for a guild.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getGuildRoster, slugifyGuild } = require('../../utils/blizzard/guild');
const { resolveRealm } = require('../../utils/blizzard/realms');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const {
  addGameOption,
  addRealmOption,
  addRegionOption,
  resolveRealmName,
  resolveScope
} = require('../../utils/commandOptions');
const { classColor, factionColor, formatNumber } = require('../../utils/wow');

const MAX_LISTED = 15;

const data = new SlashCommandBuilder()
  .setName('guild')
  .setDescription('Show a guild roster.')
  .addStringOption(option =>
    option
      .setName('guild')
      .setDescription('Guild name, exactly as it appears in game.')
      .setRequired(true)
  );

addRealmOption(data);
addGameOption(data);
addRegionOption(data);

/** Counts members per level, highest first. */
function levelSpread(members) {
  const counts = new Map();

  for (const member of members) {
    const level = member.character?.level;
    if (!Number.isFinite(level)) continue;
    counts.set(level, (counts.get(level) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[0] - a[0]);
}

/** Counts members per class, largest first. */
function classSpread(members) {
  const counts = new Map();

  for (const member of members) {
    const name = member.character?.playable_class?.name;
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function buildEmbed({ roster, scope, maxLevel }) {
  const members = roster.members ?? [];
  const guild = roster.guild ?? {};

  const atMax = members.filter(member => member.character?.level === maxLevel);
  const levels = levelSpread(members);
  const classes = classSpread(members);

  // Rank 0 is the guild master.
  const gm = members.find(member => member.rank === 0)?.character?.name;

  const embed = new EmbedBuilder()
    .setColor(factionColor(guild.faction?.name))
    .setTitle(`${guild.name ?? 'Guild'} — ${guild.realm?.name ?? scope.label}`)
    .addFields(
      { name: 'Members', value: formatNumber(members.length), inline: true },
      { name: `At Level ${maxLevel}`, value: formatNumber(atMax.length), inline: true },
      { name: 'Faction', value: guild.faction?.name ?? '—', inline: true }
    );

  if (gm) embed.addFields({ name: 'Guild Master', value: gm, inline: true });

  if (classes.length > 0) {
    embed.addFields({
      name: 'Classes',
      value: classes
        .slice(0, 8)
        .map(([name, count]) => `${name} ${count}`)
        .join(' • ')
    });
  }

  if (levels.length > 0) {
    embed.addFields({
      name: 'Levels',
      value: levels
        .slice(0, 8)
        .map(([level, count]) => `${level}: ${count}`)
        .join(' • ')
    });
  }

  // Max-level members are the raid-relevant ones, so list those rather than
  // an arbitrary slice of 240 alts.
  if (atMax.length > 0) {
    const names = atMax
      .slice(0, MAX_LISTED)
      .map(member => member.character.name)
      .join(', ');

    embed.addFields({
      name: `Level ${maxLevel} Members${atMax.length > MAX_LISTED ? ` (first ${MAX_LISTED})` : ''}`,
      value: names
    });
  }

  const classNames = classes.map(([name]) => name);
  if (classNames.length === 1) embed.setColor(classColor(classNames[0]));

  return embed;
}

async function execute(interaction) {
  await interaction.deferReply();

  const guildName = interaction.options.getString('guild');
  const realm = resolveRealmName(interaction);
  const scope = resolveScope(interaction);

  if (!realm) {
    await interaction.editReply(
      '❌ No realm given, and no default realm is configured. Pass the `realm` option.'
    );
    return;
  }

  const target = await resolveRealm(realm, { region: scope.region, game: scope.game });
  const guildSlug = slugifyGuild(guildName);

  // Max level differs per game version, and there is no endpoint for it, so take
  // the highest level actually present on the roster.
  let roster;
  try {
    roster = await getGuildRoster(target.slug, guildSlug, {
      region: scope.region,
      game: scope.game
    });
  } catch (err) {
    if (err instanceof BlizzardApiError && err.isNotFound) {
      await interaction.editReply(
        `❌ No guild called **${guildName}** on **${target.name}** (${scope.label}).\n` +
          `Looked for \`${guildSlug}\`. Guild names must be spelled as they appear in game, ` +
          'and there is no guild index to suggest near matches from.'
      );
      return;
    }
    throw err;
  }

  const members = roster.members ?? [];

  if (members.length === 0) {
    await interaction.editReply(`❌ **${guildName}** has no members the API can see.`);
    return;
  }

  const maxLevel = Math.max(...members.map(member => member.character?.level ?? 0));

  await interaction.editReply({ embeds: [buildEmbed({ roster, scope, maxLevel })] });
}

module.exports = {
  data,
  help: 'Shows a guild roster: size, class and level spread, and max-level members.',
  category: 'WoW',
  buildEmbed,
  classSpread,
  execute,
  levelSpread
};
