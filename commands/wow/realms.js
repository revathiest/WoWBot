// commands/wow/realms.js
// /realms — list or search the realms available for a region and game version.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getPlayableRealms, searchRealms } = require('../../utils/blizzard/realms');
const { addGameOption, addRegionOption, resolveScope } = require('../../utils/commandOptions');
const { FALLBACK_COLOR } = require('../../utils/wow');

// Discord's limits: 25 fields per embed, 1024 characters per field value, and
// 6000 characters across the whole embed. Stay under the total with room to
// spare for the title, description, and footer.
const MAX_FIELDS = 25;
const MAX_FIELD_CHARS = 1024;
const MAX_TOTAL_CHARS = 5000;
const MAX_SEARCH_RESULTS = 40;

const data = new SlashCommandBuilder()
  .setName('realms')
  .setDescription('List the realms available for a region and game version.')
  .addStringOption(option =>
    option
      .setName('search')
      .setDescription('Only show realms whose name contains this text.')
      .setRequired(false)
  );

addGameOption(data);
addRegionOption(data);

/**
 * Packs names into field-sized groups, labelled with the alphabetical range they
 * cover ("Aegwynn – Drak'thul") so a long list stays navigable.
 */
function groupIntoFields(names, {
  maxFields = MAX_FIELDS,
  maxChars = MAX_FIELD_CHARS,
  maxTotal = MAX_TOTAL_CHARS
} = {}) {
  const groups = [];
  let current = [];
  let length = 0;
  let total = 0;

  for (const name of names) {
    const cost = name.length + 2; // ", "

    if (current.length > 0 && length + cost > maxChars) {
      groups.push(current);
      current = [];
      length = 0;
    }

    // Stop before the embed would breach Discord's overall size limit.
    if (total + cost > maxTotal || (current.length === 0 && groups.length >= maxFields)) {
      break;
    }

    current.push(name);
    length += cost;
    total += cost;
  }

  if (current.length > 0) groups.push(current);

  return groups.slice(0, maxFields).map(group => ({
    name: group.length === 1 ? group[0] : `${group[0]} – ${group[group.length - 1]}`,
    value: group.join(', ')
  }));
}

function buildListEmbed({ realms, scope }) {
  const embed = new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle(`Realms — ${scope.label}`)
    .setDescription(`${realms.length} playable realm(s). Use any of these names with \`/character\`, \`/realm\`, or \`/mythicplus\`.`);

  const fields = groupIntoFields(realms.map(realm => realm.name));
  embed.addFields(fields);

  const shown = fields.reduce((total, field) => total + field.value.split(', ').length, 0);
  if (shown < realms.length) {
    embed.setFooter({ text: `Showing ${shown} of ${realms.length}. Use the search option to narrow it down.` });
  }

  return embed;
}

function buildSearchEmbed({ matches, query, scope }) {
  const shown = matches.slice(0, MAX_SEARCH_RESULTS);

  const embed = new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle(`Realms matching "${query}" — ${scope.label}`)
    .setDescription(shown.map(realm => `• **${realm.name}** — \`${realm.slug}\``).join('\n'));

  if (matches.length > shown.length) {
    embed.setFooter({ text: `Showing ${shown.length} of ${matches.length} matches.` });
  }

  return embed;
}

async function execute(interaction) {
  await interaction.deferReply();

  const scope = resolveScope(interaction);
  const query = interaction.options.getString('search');

  const realms = await getPlayableRealms({ region: scope.region, game: scope.game });

  if (realms.length === 0) {
    await interaction.editReply(`❌ No realms found for ${scope.label}.`);
    return;
  }

  if (!query) {
    await interaction.editReply({ embeds: [buildListEmbed({ realms, scope })] });
    return;
  }

  const matches = searchRealms(realms, query);

  if (matches.length === 0) {
    await interaction.editReply(
      `❌ No realm in ${scope.label} matches **${query}**. Run \`/realms\` with no search to see them all.`
    );
    return;
  }

  await interaction.editReply({ embeds: [buildSearchEmbed({ matches, query, scope })] });
}

module.exports = {
  data,
  help: 'Lists or searches the realms available for a region and game version.',
  category: 'WoW',
  buildListEmbed,
  buildSearchEmbed,
  execute,
  groupIntoFields
};
