// commands/wow/token.js
// /token — current WoW Token price for a region.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getWowTokenPrice } = require('../../utils/blizzard/gameData');
const { addRegionOption, resolveRegion } = require('../../utils/commandOptions');
const { discordTimestamp, formatGold } = require('../../utils/wow');

const GOLD_COLOR = 0xffd100;

const data = new SlashCommandBuilder()
  .setName('token')
  .setDescription('Show the current WoW Token price.');

addRegionOption(data, 'Region to price the token in.');

function buildEmbed({ token, region }) {
  const embed = new EmbedBuilder()
    .setColor(GOLD_COLOR)
    .setTitle(`WoW Token — ${region.toUpperCase()}`)
    .addFields({ name: 'Price', value: formatGold(token.price), inline: true });

  const updated = discordTimestamp(token.last_updated_timestamp);
  if (updated) {
    embed.addFields({ name: 'Updated', value: updated, inline: true });
  }

  return embed;
}

async function execute(interaction) {
  await interaction.deferReply();

  const region = resolveRegion(interaction);
  const token = await getWowTokenPrice({ region });

  await interaction.editReply({ embeds: [buildEmbed({ token, region })] });
}

module.exports = {
  data,
  help: 'Shows the current WoW Token price in gold for the chosen region.',
  category: 'WoW',
  buildEmbed,
  execute
};
