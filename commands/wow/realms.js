// commands/wow/realms.js
// /realms — list or search rulesets for a region.
//
// Classic Forever has no realms; it has rulesets instead (see
// utils/blizzard/rulesets.js). There are only four, so this command is mostly
// a convenience: `/realm` already shows one in full detail.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getRulesets, searchRulesets } = require('../../utils/blizzard/rulesets');
const { addRegionOption, resolveScope } = require('../../utils/commandOptions');
const { FALLBACK_COLOR } = require('../../utils/wow');

const MAX_SEARCH_RESULTS = 40;

const data = new SlashCommandBuilder()
  .setName('realms')
  .setDescription('List or search this region\'s rulesets.')
  .addStringOption(option =>
    option
      .setName('search')
      .setDescription('Only show rulesets whose name contains this text.')
      .setRequired(false)
  );

addRegionOption(data);

function buildListEmbed({ rulesets, scope }) {
  return new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle(`Rulesets — ${scope.label}`)
    .setDescription(
      `${rulesets.length} ruleset(s). These are not part of a character's address — ` +
        'characters are identified by name and surname — so this list is for reference.'
    )
    .addFields(
      rulesets.map(ruleset => ({
        name: ruleset.name,
        value: `${ruleset.status === 'UP' ? '🟢' : '🔴'} \`${ruleset.slug}\` · id ${ruleset.id}`,
        inline: true
      }))
    );
}

function buildSearchEmbed({ matches, query, scope }) {
  const shown = matches.slice(0, MAX_SEARCH_RESULTS);

  const embed = new EmbedBuilder()
    .setColor(FALLBACK_COLOR)
    .setTitle(`Rulesets matching "${query}" — ${scope.label}`)
    .setDescription(shown.map(ruleset => `• **${ruleset.name}** — \`${ruleset.slug}\``).join('\n'));

  if (matches.length > shown.length) {
    embed.setFooter({ text: `Showing ${shown.length} of ${matches.length} matches.` });
  }

  return embed;
}

async function execute(interaction) {
  await interaction.deferReply();

  const scope = resolveScope(interaction);
  const query = interaction.options.getString('search');

  const rulesets = await getRulesets({ region: scope.region });

  if (rulesets.length === 0) {
    await interaction.editReply(`❌ No rulesets found for ${scope.label}.`);
    return;
  }

  if (!query) {
    await interaction.editReply({ embeds: [buildListEmbed({ rulesets, scope })] });
    return;
  }

  const matches = searchRulesets(rulesets, query);

  if (matches.length === 0) {
    await interaction.editReply(
      `❌ No ruleset in ${scope.label} matches **${query}**. Run \`/realms\` with no search to see them all.`
    );
    return;
  }

  await interaction.editReply({ embeds: [buildSearchEmbed({ matches, query, scope })] });
}

module.exports = {
  data,
  help: 'Lists or searches this region\'s rulesets.',
  category: 'WoW',
  buildListEmbed,
  buildSearchEmbed,
  execute
};
