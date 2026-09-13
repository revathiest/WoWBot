// commands/wow/character.js
// /character — profile summary for a single character.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getCharacterProfile, getCharacterMedia } = require('../../utils/blizzard/profile');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const { findRealmGames, resolveRealm } = require('../../utils/blizzard/realms');
const { addGameOption, addRegionOption, resolveScope } = require('../../utils/commandOptions');
const {
  armoryUrl,
  classColor,
  discordTimestamp,
  formatNumber,
  mediaAsset
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

addGameOption(data);
addRegionOption(data);

function buildEmbed({ profile, media, region, realmSlug, characterName, scopeLabel }) {
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
  const scope = resolveScope(interaction);
  const { region, game } = scope;

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

  // Artwork is a nicety; a failure here should not sink the whole reply.
  let media = null;
  try {
    media = await getCharacterMedia(realmSlug, characterName, { region, game });
  } catch (err) {
    console.warn(`Could not load character media for ${characterName}-${realmSlug}: ${err.message}`);
  }

  await interaction.editReply({
    embeds: [
      buildEmbed({ profile, media, region, realmSlug, characterName, scopeLabel: scope.label })
    ]
  });
}

module.exports = {
  data,
  help: 'Shows level, class, spec, guild, item level, and achievement points for a character.',
  category: 'WoW',
  buildEmbed,
  execute
};
