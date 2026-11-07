// commands/wow/character.js
// /character — profile summary for a single character.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getCharacterProfile,
  getCharacterMedia,
  getCharacterEquipment,
  getCharacterPvpSummary
} = require('../../utils/blizzard/profile');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const {
  addRegionOption,
  addSurnameOption,
  resolveCharacterTarget,
  resolveScope
} = require('../../utils/commandOptions');
const { classColor, discordTimestamp, formatNumber, mediaAsset, wowheadItemUrl } = require('../../utils/wow');

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
      .setDescription('Character name, e.g. Judgement, or Judgement-Judy')
      .setRequired(true)
  );

addSurnameOption(data);
addRegionOption(data);

/**
 * One line per equipped item, in paperdoll order, each linked to the Wowhead
 * database. Item level is shown only when the API supplies it.
 */
function equipmentLines(equipment) {
  const bySlot = new Map(
    (equipment?.equipped_items ?? []).map(item => [item.slot?.type, item])
  );

  return EQUIPMENT_SLOTS.map(slot => bySlot.get(slot))
    .filter(Boolean)
    .map(item => {
      const name = item.name ?? 'Unknown item';
      const id = item.item?.id;
      const label = id ? `[${name}](${wowheadItemUrl(id)})` : name;
      const itemLevel = item.level?.value;

      return `**${item.slot?.name ?? '?'}** ${label}${
        Number.isFinite(itemLevel) ? ` · ${itemLevel}` : ''
      }`;
    });
}

/** Packs the equipment lines into embed fields that respect Discord's limits. */
function equipmentFields(equipment) {
  const lines = equipmentLines(equipment);
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

function buildEmbed({ profile, media, equipment, pvp, scopeLabel }) {
  const specName = profile.active_spec?.name;
  const className = profile.character_class?.name;
  const specAndClass = [specName, className].filter(Boolean).join(' ') || 'Unknown';

  // Characters have no realm; the ruleset is their "where" instead.
  const fullName = [profile.name, profile.surname].filter(Boolean).join(' ');
  const where = profile.ruleset?.name ? ` — ${profile.ruleset.name}` : '';

  // No armory link: Classic Forever has no armory page at all.
  const embed = new EmbedBuilder()
    .setColor(classColor(className))
    .setTitle(`${fullName}${where} (${scopeLabel})`)
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

  // Forever has no arena — this is the vanilla honour system, so pvp_rank is a
  // tier rather than a ladder position. A missing summary (below level 10, or
  // never logged out) just means the field is omitted, not an error.
  if (Number.isFinite(pvp?.honorable_kills)) {
    embed.addFields({
      name: 'Honorable Kills',
      value: formatNumber(pvp.honorable_kills),
      inline: true
    });
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
  const gear = equipmentFields(equipment);
  if (gear.length > 0) embed.addFields(gear);

  const avatar = mediaAsset(media, 'avatar');
  if (avatar) embed.setThumbnail(avatar);

  const render = mediaAsset(media, 'main-raw') ?? mediaAsset(media, 'main');
  if (render) embed.setImage(render);

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

  let profile;
  try {
    profile = await getCharacterProfile(characterName, { region: scope.region });
  } catch (err) {
    if (err instanceof BlizzardApiError && err.isNotFound) {
      await interaction.editReply(
        `❌ No character named **${displayName}** (${scope.label}).\n` +
          `Checked \`${characterName}\`. Characters appear only from level 10, and only ` +
          'once they have logged out, so a brand-new character will not be found yet.'
      );
      return;
    }
    throw err;
  }

  // Artwork, gear, and PvP are extras; neither failing should sink the whole reply.
  const [media, equipment, pvp] = await Promise.all([
    getCharacterMedia(characterName, { region: scope.region }).catch(err => {
      console.warn(`Could not load media for ${characterName}: ${err.message}`);
      return null;
    }),
    getCharacterEquipment(characterName, { region: scope.region }).catch(err => {
      console.warn(`Could not load equipment for ${characterName}: ${err.message}`);
      return null;
    }),
    getCharacterPvpSummary(characterName, { region: scope.region }).catch(err => {
      // A 404 here is normal — see the note in utils/blizzard/profile.js — and
      // not worth a warning on every character below level 10.
      if (!(err instanceof BlizzardApiError) || !err.isNotFound) {
        console.warn(`Could not load the PvP summary for ${characterName}: ${err.message}`);
      }
      return null;
    })
  ]);

  await interaction.editReply({
    embeds: [buildEmbed({ profile, media, equipment, pvp, scopeLabel: scope.label })]
  });
}

module.exports = {
  data,
  help: 'Shows level, class, ruleset, guild, item level, achievement points, and honorable kills for a character.',
  category: 'WoW',
  buildEmbed,
  equipmentFields,
  equipmentLines,
  execute,
  EQUIPMENT_SLOTS
};
