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
const { getRulesets, findRuleset } = require('../../utils/blizzard/rulesets');
const { getRulesetAuctionIndex } = require('../../utils/blizzard/gameData');
const { idFromHref } = require('../../utils/wow');
const { isRealmless } = require('../../config');

const UP_COLOR = 0x43b581;
const DOWN_COLOR = 0xf04747;
const MAX_SUGGESTIONS = 5;

const data = new SlashCommandBuilder()
  .setName('realm')
  .setDescription('Show the status and population of a realm.');

addRealmOption(data, undefined, {
  description: 'Realm name, or a Classic Forever ruleset (PvP, Normal, Roleplay). Omit to list all.'
});
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

/**
 * Classic Forever's answer to /realm.
 *
 * There is no realm and no connected realm, so there is no population or queue
 * flag to report — a ruleset carries a name, an up/down status, and its own set
 * of auction houses, and that is the whole of what this flavour publishes.
 *
 * With no ruleset named, every ruleset is listed: there are four, so the list is
 * more useful than an error.
 */
function buildRulesetEmbed({ ruleset, scope, auctionHouses = null }) {
  const isUp = ruleset.status === 'UP';

  const embed = new EmbedBuilder()
    .setColor(isUp ? UP_COLOR : DOWN_COLOR)
    .setTitle(`${ruleset.name} (${scope.label})`)
    .addFields(
      { name: 'Status', value: ruleset.statusLabel ?? ruleset.status ?? '—', inline: true },
      { name: 'Ruleset ID', value: String(ruleset.id), inline: true }
    );

  if (Number.isFinite(auctionHouses)) {
    embed.addFields({ name: 'Auction Houses', value: String(auctionHouses), inline: true });
  }

  // Said plainly, because somebody running /realm expected population and queue.
  embed.setFooter({
    text:
      'Classic Forever has rulesets instead of realms, so there is no population ' +
      'or queue information to show.'
  });

  return embed;
}

function buildRulesetListEmbed({ rulesets, scope }) {
  return new EmbedBuilder()
    .setColor(UP_COLOR)
    .setTitle(`Rulesets — ${scope.label}`)
    .setDescription(
      rulesets
        .map(
          ruleset =>
            `${ruleset.status === 'UP' ? '🟢' : '🔴'} **${ruleset.name}** — ` +
            `\`${ruleset.slug}\` · id ${ruleset.id}`
        )
        .join('\n')
    )
    .setFooter({ text: 'Classic Forever has rulesets instead of realms.' });
}

async function showRuleset(interaction, scope) {
  // Read the option directly rather than through `resolveRealmName`: the
  // configured BLIZZARD_REALM is a realm name, which is not a ruleset and would
  // only ever produce "no ruleset called Nightslayer". There is nothing sensible
  // to default to here, so no argument means "list them all".
  const typed = (interaction.options?.getString?.('realm') ?? '').trim();
  const lookup = { region: scope.region, game: scope.game };

  let rulesets;
  try {
    rulesets = await getRulesets(lookup);
  } catch (err) {
    await interaction.editReply(`❌ Could not read the ruleset list: ${err.message}`);
    return;
  }

  if (rulesets.length === 0) {
    await interaction.editReply(`❌ No rulesets found for ${scope.label}.`);
    return;
  }

  // No ruleset named: there are only a handful, so show them all.
  if (!typed) {
    await interaction.editReply({ embeds: [buildRulesetListEmbed({ rulesets, scope })] });
    return;
  }

  const ruleset = findRuleset(rulesets, typed);

  if (!ruleset) {
    const names = rulesets.map(entry => `**${entry.name}**`).join(', ');
    await interaction.editReply(
      `❌ No ruleset called **${typed}** in ${scope.label}. Available: ${names}.`
    );
    return;
  }

  // Auction houses are a nice extra and the only other thing a ruleset exposes;
  // a failure here must not cost the status reply.
  let auctionHouses = null;
  try {
    const index = await getRulesetAuctionIndex(ruleset.id, lookup);
    if (Array.isArray(index?.auctions)) auctionHouses = index.auctions.length;
  } catch (err) {
    console.warn(`Could not read auction houses for ruleset ${ruleset.id}: ${err.message}`);
  }

  await interaction.editReply({ embeds: [buildRulesetEmbed({ ruleset, scope, auctionHouses })] });
}

async function execute(interaction) {
  await interaction.deferReply();

  const realmName = resolveRealmName(interaction);
  const scope = resolveScope(interaction);

  // Realmless flavours have rulesets where this command expects a realm.
  if (isRealmless(scope.game)) {
    await showRuleset(interaction, scope);
    return;
  }

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
  buildRulesetEmbed,
  buildRulesetListEmbed,
  execute,
  showRuleset,
  suggestRealms
};
