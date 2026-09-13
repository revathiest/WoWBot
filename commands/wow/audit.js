// commands/wow/audit.js
// /audit — raid-readiness check for a character's enchants.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getCharacterProfile, getCharacterEquipment } = require('../../utils/blizzard/profile');
const { resolveRealm } = require('../../utils/blizzard/realms');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const {
  addGameOption,
  addRealmOption,
  addRegionOption,
  resolveRealmName,
  resolveScope
} = require('../../utils/commandOptions');
const { auditEquipment } = require('../../utils/enchants');
const { classColor, wowheadItemUrl } = require('../../utils/wow');

const PASS_COLOR = 0x43b581;
const WARN_COLOR = 0xff8c00;
const FAIL_COLOR = 0xff2222;

const data = new SlashCommandBuilder()
  .setName('audit')
  .setDescription('Check a character for missing enchants.')
  .addStringOption(option =>
    option.setName('character').setDescription('Character name.').setRequired(true)
  );

addRealmOption(data);
addGameOption(data);
addRegionOption(data);

function itemLink(item, game) {
  const id = item.item?.id;
  const name = item.name ?? 'Unknown item';
  return id ? `[${name}](${wowheadItemUrl(id, game)})` : name;
}

function buildEmbed({ profile, audit, scope, characterName, game }) {
  const { missing, optional, gemCount, requiredTotal, requiredEnchanted, optionalEnchanted } =
    audit;

  const color = missing.length === 0 ? PASS_COLOR : missing.length <= 2 ? WARN_COLOR : FAIL_COLOR;
  const verdict =
    missing.length === 0
      ? `✅ All ${requiredTotal} enchantable slots are enchanted.`
      : `⚠️ ${missing.length} missing enchant${missing.length === 1 ? '' : 's'}.`;

  const embed = new EmbedBuilder()
    .setColor(profile ? classColor(profile.character_class?.name) : color)
    .setTitle(`Enchant Audit — ${profile?.name ?? characterName} (${scope.label})`)
    .setDescription(verdict)
    .addFields(
      {
        name: 'Enchanted',
        value:
          `${requiredEnchanted} / ${requiredTotal}` +
          (optionalEnchanted > 0 ? ` (+${optionalEnchanted} ring)` : ''),
        inline: true
      },
      { name: 'Gems', value: String(gemCount), inline: true }
    );

  if (profile?.equipped_item_level) {
    embed.addFields({
      name: 'Item Level',
      value: String(profile.equipped_item_level),
      inline: true
    });
  }

  if (missing.length > 0) {
    embed.addFields({
      name: 'Missing Enchants',
      value: missing
        .map(({ item }) => `❌ **${item.slot?.name}** — ${itemLink(item, game)}`)
        .join('\n')
    });
  }

  if (optional.length > 0) {
    embed.addFields({
      name: 'Rings (enchanters only)',
      value: optional.map(({ item }) => `• ${item.slot?.name} — ${itemLink(item, game)}`).join('\n')
    });
  }

  // Sockets are not auditable: Blizzard exposes gems that are socketed but never
  // the socket list, so an empty socket cannot be told apart from no socket.
  embed.setFooter({
    text: 'Enchants only — Blizzard does not expose empty sockets, so gems cannot be audited.'
  });

  return embed;
}

async function execute(interaction) {
  await interaction.deferReply();

  const characterName = interaction.options.getString('character');
  const realm = resolveRealmName(interaction);
  const scope = resolveScope(interaction);

  if (!realm) {
    await interaction.editReply(
      '❌ No realm given, and no default realm is configured. Pass the `realm` option.'
    );
    return;
  }

  const target = await resolveRealm(realm, { region: scope.region, game: scope.game });
  const lookup = { region: scope.region, game: scope.game };

  let equipment;
  try {
    equipment = await getCharacterEquipment(target.slug, characterName, lookup);
  } catch (err) {
    if (err instanceof BlizzardApiError && err.isNotFound) {
      await interaction.editReply(
        `❌ No character named **${characterName}** on **${target.name}** (${scope.label}).`
      );
      return;
    }
    throw err;
  }

  // The profile only supplies colour and item level, so a failure here is not fatal.
  const profile = await getCharacterProfile(target.slug, characterName, lookup).catch(err => {
    console.warn(`Could not load profile for ${characterName}: ${err.message}`);
    return null;
  });

  const audit = auditEquipment(equipment);

  if (audit.checked === 0) {
    await interaction.editReply(
      `❌ **${characterName}** has nothing equipped that takes an enchant.`
    );
    return;
  }

  await interaction.editReply({
    embeds: [buildEmbed({ profile, audit, scope, characterName, game: scope.game })]
  });
}

module.exports = {
  data,
  help: 'Checks a character for missing enchants on raid-relevant slots.',
  category: 'WoW',
  buildEmbed,
  execute,
  itemLink
};
