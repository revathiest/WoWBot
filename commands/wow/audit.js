// commands/wow/audit.js
// /audit — raid-readiness check for a character's enchants.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getCharacterProfile, getCharacterEquipment } = require('../../utils/blizzard/profile');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const {
  addRegionOption,
  addSurnameOption,
  resolveCharacterTarget,
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

addSurnameOption(data);
addRegionOption(data);

function itemLink(item) {
  const id = item.item?.id;
  const name = item.name ?? 'Unknown item';
  return id ? `[${name}](${wowheadItemUrl(id)})` : name;
}

function buildEmbed({ profile, audit, scope, characterName }) {
  const { missing, optional, gemCount, requiredTotal, requiredEnchanted, optionalEnchanted } =
    audit;

  const color = missing.length === 0 ? PASS_COLOR : missing.length <= 2 ? WARN_COLOR : FAIL_COLOR;
  const verdict =
    missing.length === 0
      ? `✅ All ${requiredTotal} enchantable slots are enchanted.`
      : `⚠️ ${missing.length} missing enchant${missing.length === 1 ? '' : 's'}.`;

  const embed = new EmbedBuilder()
    .setColor(profile ? classColor(profile.character_class?.name) : color)
    // Blizzard's casing beats what was typed, but only if it is the WHOLE name:
    // a profile splits it across `name` and `surname`.
    .setTitle(
      `Enchant Audit — ${
        [profile?.name, profile?.surname].filter(Boolean).join(' ') || characterName
      } (${scope.label})`
    )
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
      value: missing.map(({ item }) => `❌ **${item.slot?.name}** — ${itemLink(item)}`).join('\n')
    });
  }

  if (optional.length > 0) {
    embed.addFields({
      name: 'Rings (enchanters only)',
      value: optional.map(({ item }) => `• ${item.slot?.name} — ${itemLink(item)}`).join('\n')
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

  const scope = resolveScope(interaction);
  const target = resolveCharacterTarget({ interaction });

  if (target.error) {
    await interaction.editReply(`❌ ${target.error}`);
    return;
  }

  const { characterName, displayName } = target;
  const lookup = { region: scope.region };

  let equipment;
  try {
    equipment = await getCharacterEquipment(characterName, lookup);
  } catch (err) {
    if (err instanceof BlizzardApiError && err.isNotFound) {
      await interaction.editReply(`❌ No character named **${displayName}** (${scope.label}).`);
      return;
    }
    throw err;
  }

  // The profile only supplies colour and item level, so a failure here is not fatal.
  const profile = await getCharacterProfile(characterName, lookup).catch(err => {
    console.warn(`Could not load profile for ${characterName}: ${err.message}`);
    return null;
  });

  const audit = auditEquipment(equipment);

  if (audit.checked === 0) {
    await interaction.editReply(`❌ **${displayName}** has nothing equipped that takes an enchant.`);
    return;
  }

  await interaction.editReply({
    embeds: [buildEmbed({ profile, audit, scope, characterName: displayName })]
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
