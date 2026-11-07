// commands/wow/realm.js
// /realm — ruleset status and auction houses.
//
// Classic Forever has no realms: rulesets are what it has instead (see
// utils/blizzard/rulesets.js). A ruleset carries a name, an up/down status,
// and its own auction houses — no population, no queue, no connected realms,
// because none of that exists for this flavour.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getRulesetAuctionIndex } = require('../../utils/blizzard/gameData');
const { getRulesets, findRuleset } = require('../../utils/blizzard/rulesets');
const { addRegionOption, resolveScope } = require('../../utils/commandOptions');

const UP_COLOR = 0x43b581;
const DOWN_COLOR = 0xf04747;

const data = new SlashCommandBuilder()
  .setName('realm')
  .setDescription('Show the status and auction houses for a ruleset.')
  .addStringOption(option =>
    option
      .setName('ruleset')
      .setDescription('Ruleset name (PvP, Normal, Roleplay, Roleplay PvP), or its id. Omit to list all.')
      .setRequired(false)
  );

addRegionOption(data);

/**
 * With no ruleset named, every ruleset is listed: there are only four, so the
 * list is more useful than an error.
 */
function buildEmbed({ ruleset, scope, auctionHouses = null }) {
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

  return embed;
}

function buildListEmbed({ rulesets, scope }) {
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
    );
}

async function execute(interaction) {
  await interaction.deferReply();

  const typed = (interaction.options.getString('ruleset') ?? '').trim();
  const scope = resolveScope(interaction);
  const lookup = { region: scope.region };

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
    await interaction.editReply({ embeds: [buildListEmbed({ rulesets, scope })] });
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

  // Auction houses are the only other thing a ruleset exposes; a failure here
  // must not cost the status reply.
  let auctionHouses = null;
  try {
    const index = await getRulesetAuctionIndex(ruleset.id, lookup);
    if (Array.isArray(index?.auctions)) auctionHouses = index.auctions.length;
  } catch (err) {
    console.warn(`Could not read auction houses for ruleset ${ruleset.id}: ${err.message}`);
  }

  await interaction.editReply({ embeds: [buildEmbed({ ruleset, scope, auctionHouses })] });
}

module.exports = {
  data,
  help: 'Shows a ruleset\'s status, id, and auction-house count.',
  category: 'WoW',
  buildEmbed,
  buildListEmbed,
  execute
};
