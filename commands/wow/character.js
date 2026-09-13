// commands/wow/character.js
// /character — profile summary for a single character.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getCharacterProfile, getCharacterMedia } = require('../../utils/blizzard/profile');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const { addRegionOption, resolveRegion } = require('../../utils/commandOptions');
const {
  armoryUrl,
  classColor,
  discordTimestamp,
  formatNumber,
  mediaAsset,
  slugifyRealm
} = require('../../utils/wow');

const data = new SlashCommandBuilder()
  .setName('character')
  .setDescription('Look up a World of Warcraft character.')
  .addStringOption(option =>
    option
      .setName('character')
      .setDescription('Character name, e.g. Thrall')
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName('realm')
      .setDescription('Realm name, e.g. Area 52')
      .setRequired(true)
  );

addRegionOption(data);

function buildEmbed({ profile, media, region, realmSlug, characterName }) {
  const specName = profile.active_spec?.name;
  const className = profile.character_class?.name;
  const specAndClass = [specName, className].filter(Boolean).join(' ') || 'Unknown';

  const embed = new EmbedBuilder()
    .setColor(classColor(className))
    .setTitle(`${profile.name} — ${profile.realm?.name ?? realmSlug} (${region.toUpperCase()})`)
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

  const avatar = mediaAsset(media, 'avatar');
  if (avatar) embed.setThumbnail(avatar);

  const render = mediaAsset(media, 'main-raw') ?? mediaAsset(media, 'main');
  if (render) embed.setImage(render);

  return embed;
}

async function execute(interaction) {
  await interaction.deferReply();

  const characterName = interaction.options.getString('character');
  const realm = interaction.options.getString('realm');
  const region = resolveRegion(interaction);
  const realmSlug = slugifyRealm(realm);

  let profile;
  try {
    profile = await getCharacterProfile(realm, characterName, { region });
  } catch (err) {
    if (err instanceof BlizzardApiError && err.isNotFound) {
      await interaction.editReply(
        `❌ No character named **${characterName}** on **${realm}** (${region.toUpperCase()}).\n` +
          `Checked realm slug \`${realmSlug}\`. Characters below level 10 and recently renamed characters may not appear.`
      );
      return;
    }
    throw err;
  }

  // Artwork is a nicety; a failure here should not sink the whole reply.
  let media = null;
  try {
    media = await getCharacterMedia(realm, characterName, { region });
  } catch (err) {
    console.warn(`Could not load character media for ${characterName}-${realmSlug}: ${err.message}`);
  }

  await interaction.editReply({
    embeds: [buildEmbed({ profile, media, region, realmSlug, characterName })]
  });
}

module.exports = {
  data,
  help: 'Shows level, class, spec, guild, item level, and achievement points for a character.',
  category: 'WoW',
  buildEmbed,
  execute
};
