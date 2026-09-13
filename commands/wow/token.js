// commands/wow/token.js
// /token — current WoW Token price for a region.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getWowTokenPrice } = require('../../utils/blizzard/gameData');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const { addGameOption, addRegionOption, resolveScope } = require('../../utils/commandOptions');
const { discordTimestamp, formatGold } = require('../../utils/wow');

const GOLD_COLOR = 0xffd100;

const data = new SlashCommandBuilder()
  .setName('token')
  .setDescription('Show the current WoW Token price.');

addGameOption(data);
addRegionOption(data, 'Region to price the token in.');

function buildEmbed({ token, scopeLabel }) {
  const embed = new EmbedBuilder()
    .setColor(GOLD_COLOR)
    .setTitle(`WoW Token — ${scopeLabel}`)
    .addFields({ name: 'Price', value: formatGold(token.price), inline: true });

  const updated = discordTimestamp(token.last_updated_timestamp);
  if (updated) {
    embed.addFields({ name: 'Updated', value: updated, inline: true });
  }

  return embed;
}

async function execute(interaction) {
  await interaction.deferReply();

  const scope = resolveScope(interaction);

  let token;
  try {
    token = await getWowTokenPrice({ region: scope.region, game: scope.game });
  } catch (err) {
    // TBC Anniversary has no WoW Token, and the endpoint 404s rather than
    // returning an empty result.
    if (err instanceof BlizzardApiError && err.isNotFound) {
      await interaction.editReply(`❌ There is no WoW Token in ${scope.label}.`);
      return;
    }
    throw err;
  }

  await interaction.editReply({ embeds: [buildEmbed({ token, scopeLabel: scope.label })] });
}

module.exports = {
  data,
  help: 'Shows the current WoW Token price in gold for the chosen region.',
  category: 'WoW',
  buildEmbed,
  execute
};
