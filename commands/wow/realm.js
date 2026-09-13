// commands/wow/realm.js
// /realm — realm status, population, and connected-realm roster.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getRealm, getConnectedRealm, getRealmIndex } = require('../../utils/blizzard/gameData');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const { addRegionOption, resolveRegion } = require('../../utils/commandOptions');
const { idFromHref, slugifyRealm } = require('../../utils/wow');

const UP_COLOR = 0x43b581;
const DOWN_COLOR = 0xf04747;
const MAX_SUGGESTIONS = 5;

const data = new SlashCommandBuilder()
  .setName('realm')
  .setDescription('Show the status and population of a realm.')
  .addStringOption(option =>
    option
      .setName('realm')
      .setDescription('Realm name, e.g. Area 52')
      .setRequired(true)
  );

addRegionOption(data);

function buildEmbed({ realm, connectedRealm, region }) {
  const isUp = connectedRealm?.status?.type === 'UP';

  const embed = new EmbedBuilder()
    .setColor(connectedRealm ? (isUp ? UP_COLOR : DOWN_COLOR) : UP_COLOR)
    .setTitle(`${realm.name} (${region.toUpperCase()})`)
    .addFields(
      { name: 'Type', value: realm.type?.name ?? '—', inline: true },
      { name: 'Category', value: realm.category ?? '—', inline: true },
      { name: 'Timezone', value: realm.timezone ?? '—', inline: true }
    );

  if (connectedRealm) {
    embed.addFields(
      {
        name: 'Status',
        value: `${isUp ? '🟢' : '🔴'} ${connectedRealm.status?.name ?? 'Unknown'}`,
        inline: true
      },
      { name: 'Population', value: connectedRealm.population?.name ?? '—', inline: true },
      { name: 'Queue', value: connectedRealm.has_queue ? 'Yes' : 'No', inline: true }
    );

    const connected = (connectedRealm.realms ?? [])
      .map(entry => entry.name)
      .filter(Boolean);

    if (connected.length > 1) {
      embed.addFields({ name: 'Connected Realms', value: connected.join(', ') });
    }
  }

  return embed;
}

/** On a miss, offer realms whose name or slug contains what the user typed. */
async function suggestRealms(query, region) {
  try {
    const index = await getRealmIndex({ region });
    const needle = slugifyRealm(query);

    return (index.realms ?? [])
      .filter(realm => String(realm.slug ?? '').includes(needle) || needle.includes(String(realm.slug ?? '')))
      .slice(0, MAX_SUGGESTIONS)
      .map(realm => realm.name);
  } catch (err) {
    console.warn(`Could not load the realm index for suggestions: ${err.message}`);
    return [];
  }
}

async function execute(interaction) {
  await interaction.deferReply();

  const realmName = interaction.options.getString('realm');
  const region = resolveRegion(interaction);

  let realm;
  try {
    realm = await getRealm(realmName, { region });
  } catch (err) {
    if (err instanceof BlizzardApiError && err.isNotFound) {
      const suggestions = await suggestRealms(realmName, region);
      const hint = suggestions.length > 0 ? `\nDid you mean: ${suggestions.join(', ')}?` : '';

      await interaction.editReply(
        `❌ No realm called **${realmName}** in ${region.toUpperCase()} (looked for \`${slugifyRealm(realmName)}\`).${hint}`
      );
      return;
    }
    throw err;
  }

  // Status and population live on the connected realm, not the realm itself.
  let connectedRealm = null;
  const connectedRealmId = idFromHref(realm.connected_realm?.href);

  if (connectedRealmId) {
    try {
      connectedRealm = await getConnectedRealm(connectedRealmId, { region });
    } catch (err) {
      console.warn(`Could not load connected realm ${connectedRealmId}: ${err.message}`);
    }
  }

  await interaction.editReply({ embeds: [buildEmbed({ realm, connectedRealm, region })] });
}

module.exports = {
  data,
  help: 'Shows a realm\'s status, population, type, and the realms it is connected to.',
  category: 'WoW',
  buildEmbed,
  execute,
  suggestRealms
};
