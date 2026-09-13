// commands/wow/item.js
// /item — look an item up by id, or by exact name via the item search endpoint.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getItem, getItemMedia, searchItems } = require('../../utils/blizzard/gameData');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const { addGameOption, addRegionOption, resolveScope } = require('../../utils/commandOptions');
const { readConfig } = require('../../config');
const { formatGold, localized, mediaAsset, qualityColor, wowheadItemUrl } = require('../../utils/wow');

const MAX_MATCHES_LISTED = 10;

const data = new SlashCommandBuilder()
  .setName('item')
  .setDescription('Look up a World of Warcraft item.')
  .addStringOption(option =>
    option
      .setName('query')
      .setDescription('Item name (exact) or item ID, e.g. Thunderfury or 19019')
      .setRequired(true)
  );

addGameOption(data);
addRegionOption(data);

function isItemId(query) {
  return /^\d+$/.test(query.trim());
}

function buildEmbed({ item, iconUrl, locale, game = 'retail' }) {
  const quality = localized(item.quality?.name, locale);
  const name = localized(item.name, locale) ?? 'Unknown item';

  const embed = new EmbedBuilder()
    .setColor(qualityColor(item.quality?.type ?? quality))
    .setTitle(name)
    .setURL(wowheadItemUrl(item.id, game))
    .addFields(
      { name: 'Item ID', value: String(item.id), inline: true },
      { name: 'Quality', value: quality ?? '—', inline: true },
      { name: 'Item Level', value: String(item.level ?? '—'), inline: true }
    );

  const itemClass = localized(item.item_class?.name, locale);
  const itemSubclass = localized(item.item_subclass?.name, locale);
  const classText = [itemClass, itemSubclass].filter(Boolean).join(' — ');

  if (classText) {
    embed.addFields({ name: 'Type', value: classText, inline: true });
  }

  const inventoryType = localized(item.inventory_type?.name, locale);
  if (inventoryType && inventoryType !== 'Non-equippable') {
    embed.addFields({ name: 'Slot', value: inventoryType, inline: true });
  }

  if (Number.isFinite(item.required_level) && item.required_level > 0) {
    embed.addFields({ name: 'Requires Level', value: String(item.required_level), inline: true });
  }

  if (Number.isFinite(item.sell_price) && item.sell_price > 0) {
    embed.addFields({ name: 'Sells For', value: formatGold(item.sell_price), inline: true });
  }

  if (iconUrl) embed.setThumbnail(iconUrl);

  return embed;
}

/** Icons are a separate document; a failure there should not lose the item itself. */
async function loadIcon(itemId, scope) {
  try {
    const media = await getItemMedia(itemId, { region: scope.region, game: scope.game });
    return mediaAsset(media, 'icon');
  } catch (err) {
    console.warn(`Could not load media for item ${itemId}: ${err.message}`);
    return null;
  }
}

async function replyWithItem(interaction, itemId, scope, locale) {
  const item = await getItem(itemId, { region: scope.region, game: scope.game });
  const iconUrl = await loadIcon(item.id, scope);

  await interaction.editReply({ embeds: [buildEmbed({ item, iconUrl, locale, game: scope.game })] });
}

async function execute(interaction) {
  await interaction.deferReply();

  const query = interaction.options.getString('query').trim();
  const scope = resolveScope(interaction);
  const locale = readConfig().blizzard.locale;

  if (isItemId(query)) {
    try {
      await replyWithItem(interaction, query, scope, locale);
    } catch (err) {
      if (err instanceof BlizzardApiError && err.isNotFound) {
        await interaction.editReply(`❌ No item with ID **${query}**.`);
        return;
      }
      throw err;
    }
    return;
  }

  const search = await searchItems(query, { region: scope.region, game: scope.game, locale });
  const results = search.results ?? [];

  if (results.length === 0) {
    await interaction.editReply(
      `❌ No item named **${query}**.\n` +
        'Blizzard\'s item search matches full names only, so partial names will not find anything. ' +
        'Try the exact in-game name, or pass the item ID.'
    );
    return;
  }

  // An exact single hit is the common case; show the full item card for it.
  if (results.length === 1) {
    await replyWithItem(interaction, results[0].data.id, scope, locale);
    return;
  }

  const lines = results.slice(0, MAX_MATCHES_LISTED).map(result => {
    const item = result.data;
    const name = localized(item.name, locale) ?? 'Unknown';
    return `• **${name}** — ID \`${item.id}\` (ilvl ${item.level ?? '?'})`;
  });

  const extra = results.length > MAX_MATCHES_LISTED
    ? `\n…and ${results.length - MAX_MATCHES_LISTED} more.`
    : '';

  await interaction.editReply(
    `Found ${results.length} items named **${query}**. Re-run with an ID for details:\n${lines.join('\n')}${extra}`
  );
}

module.exports = {
  data,
  help: 'Looks up an item by exact name or item ID and shows its quality, level, and slot.',
  category: 'WoW',
  buildEmbed,
  execute,
  isItemId
};
