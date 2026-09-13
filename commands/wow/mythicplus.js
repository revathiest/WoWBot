// commands/wow/mythicplus.js
// /mythicplus — Mythic Keystone rating and best runs for a character.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getMythicKeystoneProfile,
  getMythicKeystoneSeason
} = require('../../utils/blizzard/profile');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const { addRegionOption, resolveRegion } = require('../../utils/commandOptions');
const {
  armoryUrl,
  discordTimestamp,
  formatDuration,
  slugifyRealm
} = require('../../utils/wow');

const MAX_RUNS_SHOWN = 8;

const data = new SlashCommandBuilder()
  .setName('mythicplus')
  .setDescription('Show a character\'s Mythic+ rating and best keystone runs.')
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

/** Blizzard returns rating colours as RGBA components; Discord wants an integer. */
function ratingColor(rating) {
  const { r, g, b } = rating?.color ?? {};

  if ([r, g, b].every(channel => Number.isFinite(channel))) {
    return (Math.round(r) << 16) + (Math.round(g) << 8) + Math.round(b);
  }

  return 0x5865f2;
}

function formatRun(run) {
  const dungeon = run.dungeon?.name ?? 'Unknown dungeon';
  const level = run.keystone_level ?? '?';
  const timed = run.is_completed_within_time ? '✅' : '⏳';
  const duration = formatDuration(run.duration);
  const score = run.mythic_rating?.rating;
  const scoreText = Number.isFinite(score) ? ` • ${score.toFixed(1)}` : '';

  return `${timed} **+${level}** ${dungeon} — ${duration}${scoreText}`;
}

function buildEmbed({ runs, rating, region, realmSlug, characterName, seasonId }) {
  const embed = new EmbedBuilder()
    .setColor(ratingColor(rating))
    .setTitle(`Mythic+ — ${characterName} (${region.toUpperCase()})`)
    .setURL(armoryUrl({ region, realmSlug, characterName }));

  const score = rating?.rating;
  embed.addFields({
    name: 'Mythic+ Rating',
    value: Number.isFinite(score) ? score.toFixed(1) : 'Unrated',
    inline: true
  });

  if (seasonId) {
    embed.addFields({ name: 'Season', value: String(seasonId), inline: true });
  }

  if (runs.length === 0) {
    embed.setDescription('No completed keystone runs recorded for this season.');
    return embed;
  }

  const best = [...runs]
    .sort((a, b) => (b.keystone_level ?? 0) - (a.keystone_level ?? 0))
    .slice(0, MAX_RUNS_SHOWN);

  embed.setDescription(best.map(formatRun).join('\n'));

  const mostRecent = runs.reduce(
    (latest, run) => Math.max(latest, Number(run.completed_timestamp) || 0),
    0
  );
  const timestamp = discordTimestamp(mostRecent);
  if (timestamp) {
    embed.addFields({ name: 'Latest Run', value: timestamp, inline: true });
  }

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
    profile = await getMythicKeystoneProfile(realm, characterName, { region });
  } catch (err) {
    if (err instanceof BlizzardApiError && err.isNotFound) {
      await interaction.editReply(
        `❌ No Mythic+ data for **${characterName}** on **${realm}** (${region.toUpperCase()}).\n` +
          'Either the character does not exist or it has never completed a keystone.'
      );
      return;
    }
    throw err;
  }

  let runs = profile.current_period?.best_runs ?? [];
  let rating = profile.current_mythic_rating ?? null;

  // The index only covers the current weekly period. The latest season endpoint
  // has the character's actual best runs, so prefer it when one is available.
  // Blizzard does not return `seasons` in chronological order — a live payload
  // looked like [18, 11, 12, 13, 17, ...] — so take the highest id, not the last.
  const seasons = profile.seasons ?? [];
  const seasonIds = seasons.map(season => Number(season?.id)).filter(Number.isFinite);
  const latestSeasonId = seasonIds.length > 0 ? Math.max(...seasonIds) : null;

  if (latestSeasonId) {
    try {
      const season = await getMythicKeystoneSeason(realm, characterName, latestSeasonId, { region });
      runs = season.best_runs ?? runs;
      rating = season.mythic_rating ?? rating;
    } catch (err) {
      console.warn(`Could not load M+ season ${latestSeasonId} for ${characterName}: ${err.message}`);
    }
  }

  await interaction.editReply({
    embeds: [
      buildEmbed({ runs, rating, region, realmSlug, characterName, seasonId: latestSeasonId })
    ]
  });
}

module.exports = {
  data,
  help: 'Shows Mythic+ rating and the best keystone runs for a character this season.',
  category: 'WoW',
  buildEmbed,
  execute,
  formatRun,
  ratingColor
};
