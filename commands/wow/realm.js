// commands/wow/realm.js
// /realm — realm status, population, and connected-realm roster.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getRealm, getConnectedRealm } = require('../../utils/blizzard/gameData');
const {
  findRealmGames,
  getPlayableRealms,
  resolveRealm,
  searchRealms
} = require('../../utils/blizzard/realms');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const {
  addGameOption,
  addRealmOption,
  addRegionOption,
  resolveRealmName,
  resolveScope
} = require('../../utils/commandOptions');
const { idFromHref } = require('../../utils/wow');

const UP_COLOR = 0x43b581;
const DOWN_COLOR = 0xf04747;
const MAX_SUGGESTIONS = 5;

const data = new SlashCommandBuilder()
  .setName('realm')
  .setDescription('Show the status and population of a realm.');

addRealmOption(data);
addGameOption(data);
addRegionOption(data);

function buildEmbed({ realm, connectedRealm, scope }) {
  const isUp = connectedRealm?.status?.type === 'UP';

  const embed = new EmbedBuilder()
    .setColor(connectedRealm ? (isUp ? UP_COLOR : DOWN_COLOR) : UP_COLOR)
    .setTitle(`${realm.name} (${scope.label})`)
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
async function suggestRealms(query, scope) {
  try {
    const realms = await getPlayableRealms({ region: scope.region, game: scope.game });
    return searchRealms(realms, query).slice(0, MAX_SUGGESTIONS).map(realm => realm.name);
  } catch (err) {
    console.warn(`Could not load the realm index for suggestions: ${err.message}`);
    return [];
  }
}

async function execute(interaction) {
  await interaction.deferReply();

  const realmName = resolveRealmName(interaction);
  const scope = resolveScope(interaction);

  if (!realmName) {
    await interaction.editReply(
      '❌ No realm given, and no default realm is configured. Pass the `realm` option.'
    );
    return;
  }

  // Resolve against the real realm list rather than guessing the slug.
  const target = await resolveRealm(realmName, { region: scope.region, game: scope.game });

  let realm;
  try {
    realm = await getRealm(target.slug, { region: scope.region, game: scope.game });
  } catch (err) {
    if (err instanceof BlizzardApiError && err.isNotFound) {
      // Most often the realm exists, just in another game version.
      const elsewhere = await findRealmGames(realmName, {
        region: scope.region,
        exclude: scope.game
      });

      if (elsewhere.length > 0) {
        const options = elsewhere.map(match => `\`game:${match.label}\``).join(' or ');
        await interaction.editReply(
          `❌ **${realmName}** is not a ${scope.label} realm — it is on ${options}.`
        );
        return;
      }

      const suggestions = await suggestRealms(realmName, scope);
      const hint = suggestions.length > 0 ? `\nDid you mean: ${suggestions.join(', ')}?` : '';

      await interaction.editReply(
        `❌ No realm called **${realmName}** in ${scope.label} (looked for \`${target.slug}\`).${hint}`
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
      connectedRealm = await getConnectedRealm(connectedRealmId, {
        region: scope.region,
        game: scope.game
      });
    } catch (err) {
      console.warn(`Could not load connected realm ${connectedRealmId}: ${err.message}`);
    }
  }

  await interaction.editReply({ embeds: [buildEmbed({ realm, connectedRealm, scope })] });
}

module.exports = {
  data,
  help: 'Shows a realm\'s status, population, type, and the realms it is connected to.',
  category: 'WoW',
  buildEmbed,
  execute,
  suggestRealms
};
