// commands/wow/character.js
// /character — profile summary for a single character.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getCharacterProfile,
  getCharacterMedia,
  getCharacterEquipment
} = require('../../utils/blizzard/profile');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const { findRealmGames, resolveRealm } = require('../../utils/blizzard/realms');
const {
  addGameOption,
  addRealmOption,
  addRegionOption,
  resolveRealmName,
  resolveScope
} = require('../../utils/commandOptions');
const {
  armoryUrl,
  classColor,
  discordTimestamp,
  formatNumber,
  mediaAsset,
  wowheadItemUrl
} = require('../../utils/wow');

// Paperdoll order. Cosmetic slots (SHIRT, TABARD) are deliberately omitted so the
// embed stays readable; everything a raider cares about is here.
const EQUIPMENT_SLOTS = [
  'HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS',
  'FEET', 'FINGER_1', 'FINGER_2', 'TRINKET_1', 'TRINKET_2', 'MAIN_HAND', 'OFF_HAND', 'RANGED'
];

const MAX_FIELD_CHARS = 1024;
const MAX_EQUIPMENT_FIELDS = 3;

const data = new SlashCommandBuilder()
  .setName('character')
  .setDescription('Look up a World of Warcraft character.')
  .addStringOption(option =>
    option
      .setName('character')
      .setDescription('Character name, e.g. Thrall')
      .setRequired(true)
  );

addRealmOption(data);
addGameOption(data);
addRegionOption(data);

/**
 * One line per equipped item, in paperdoll order, each linked to the Wowhead
 * database for that game version. Item level is shown only when the API supplies
 * it — TBC equipment payloads omit `level.value` entirely, where retail has it.
 */
function equipmentLines(equipment, game = 'retail') {
  const bySlot = new Map(
    (equipment?.equipped_items ?? []).map(item => [item.slot?.type, item])
  );

  return EQUIPMENT_SLOTS.map(slot => bySlot.get(slot))
    .filter(Boolean)
    .map(item => {
      const name = item.name ?? 'Unknown item';
      const id = item.item?.id;
      const label = id ? `[${name}](${wowheadItemUrl(id, game)})` : name;
      const itemLevel = item.level?.value;

      return `**${item.slot?.name ?? '?'}** ${label}${
        Number.isFinite(itemLevel) ? ` · ${itemLevel}` : ''
      }`;
    });
}

/** Packs the equipment lines into embed fields that respect Discord's limits. */
function equipmentFields(equipment, game = 'retail') {
  const lines = equipmentLines(equipment, game);
  if (lines.length === 0) return [];

  const groups = [];
  let current = [];
  let length = 0;

  for (const line of lines) {
    if (current.length > 0 && length + line.length + 1 > MAX_FIELD_CHARS) {
      groups.push(current);
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }

  if (current.length > 0) groups.push(current);

  return groups.slice(0, MAX_EQUIPMENT_FIELDS).map((group, index) => ({
    // A zero-width space keeps continuation fields visually unlabelled.
    name: index === 0 ? 'Equipment' : '​',
    value: group.join('\n')
  }));
}

function buildEmbed({ profile, media, equipment, region, realmSlug, characterName, scopeLabel, game }) {
  const specName = profile.active_spec?.name;
  const className = profile.character_class?.name;
  const specAndClass = [specName, className].filter(Boolean).join(' ') || 'Unknown';

  const embed = new EmbedBuilder()
    .setColor(classColor(className))
    .setTitle(`${profile.name} — ${profile.realm?.name ?? realmSlug} (${scopeLabel ?? region.toUpperCase()})`)
    .setURL(armoryUrl({ region, realmSlug, characterName }))
    .addFields(
      { name: 'Level', value: String(profile.level ?? '—'), inline: true },
      { name: 'Race', value: profile.race?.name ?? '—', inline: true },
      { name: 'Class', value: specAndClass, inline: true },
      { name: 'Faction', value: profile.faction?.name ?? '—', inline: true },
      {
        name: 'Item Level',
        value: `${profile.equipped_item_level ?? '—'} equipped / ${profile.average_item_level ?? '—'} avg`,
        inline: true
      },
      {
        name: 'Achievements',
        value: formatNumber(profile.achievement_points),
        inline: true
      }
    );

  if (profile.guild?.name) {
    embed.addFields({ name: 'Guild', value: `<${profile.guild.name}>`, inline: true });
  }

  if (profile.active_title?.display_string) {
    embed.addFields({
      name: 'Title',
      value: profile.active_title.display_string.replace('{name}', profile.name),
      inline: true
    });
  }

  const lastLogin = discordTimestamp(profile.last_login_timestamp);
  if (lastLogin) {
    embed.addFields({ name: 'Last Login', value: lastLogin, inline: true });
  }

  // Equipment goes last so the stat fields stay at the top of the embed.
  const gear = equipmentFields(equipment, game);
  if (gear.length > 0) embed.addFields(gear);

  const avatar = mediaAsset(media, 'avatar');
  if (avatar) embed.setThumbnail(avatar);

  const render = mediaAsset(media, 'main-raw') ?? mediaAsset(media, 'main');
  if (render) embed.setImage(render);

  return embed;
}

async function execute(interaction) {
  await interaction.deferReply();

  const characterName = interaction.options.getString('character');
  const realm = resolveRealmName(interaction);
  const scope = resolveScope(interaction);
  const { region, game } = scope;

  if (!realm) {
    await interaction.editReply(
      '❌ No realm given, and no default realm is configured. Pass the `realm` option.'
    );
    return;
  }

  const target = await resolveRealm(realm, { region, game });
  const realmSlug = target.slug;

  let profile;
  try {
    profile = await getCharacterProfile(realmSlug, characterName, { region, game });
  } catch (err) {
    if (err instanceof BlizzardApiError && err.isNotFound) {
      // The usual cause is the right realm in the wrong game version, so look the
      // realm up elsewhere and say exactly which option to pass.
      if (!target.resolved) {
        const elsewhere = await findRealmGames(realm, { region, exclude: game });

        if (elsewhere.length > 0) {
          const options = elsewhere.map(match => `\`game:${match.label}\``).join(' or ');
          await interaction.editReply(
            `❌ **${realm}** is not a ${scope.label} realm — it is on ${options}.\n` +
              `Run the command again with that \`game\` option to look up **${characterName}**.`
          );
          return;
        }
      }

      await interaction.editReply(
        `❌ No character named **${characterName}** on **${realm}** (${scope.label}).\n` +
          `Checked realm slug \`${realmSlug}\`. Characters below level 10 and recently ` +
          'renamed characters may not appear.'
      );
      return;
    }
    throw err;
  }

  // Artwork and gear are extras; neither failing should sink the whole reply.
  const [media, equipment] = await Promise.all([
    getCharacterMedia(realmSlug, characterName, { region, game }).catch(err => {
      console.warn(`Could not load media for ${characterName}-${realmSlug}: ${err.message}`);
      return null;
    }),
    getCharacterEquipment(realmSlug, characterName, { region, game }).catch(err => {
      console.warn(`Could not load equipment for ${characterName}-${realmSlug}: ${err.message}`);
      return null;
    })
  ]);

  await interaction.editReply({
    embeds: [
      buildEmbed({
        profile,
        media,
        equipment,
        region,
        realmSlug,
        characterName,
        scopeLabel: scope.label,
        game
      })
    ]
  });
}

module.exports = {
  data,
  help: 'Shows level, class, spec, guild, item level, and achievement points for a character.',
  category: 'WoW',
  buildEmbed,
  equipmentFields,
  equipmentLines,
  execute,
  EQUIPMENT_SLOTS
};
