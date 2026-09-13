// commands/wow/arena.js
// /arena — arena ladder standings.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  BRACKETS,
  findOnLadder,
  getCurrentSeasonId,
  getLeaderboard
} = require('../../utils/blizzard/pvp');
const { resolveRealm } = require('../../utils/blizzard/realms');
const {
  addGameOption,
  addRealmOption,
  addRegionOption,
  resolveRealmName,
  resolveScope
} = require('../../utils/commandOptions');
const { formatNumber, FALLBACK_COLOR } = require('../../utils/wow');

const ARENA_COLOR = 0xc41e3a;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

const BRACKET_CHOICES = BRACKETS.map(bracket => ({ name: bracket, value: bracket }));

const data = new SlashCommandBuilder()
  .setName('arena')
  .setDescription('Arena ladder standings.')
  .addSubcommand(sub => {
    sub
      .setName('ladder')
      .setDescription('Top of the arena ladder.')
      .addStringOption(option =>
        option
          .setName('bracket')
          .setDescription('Arena bracket.')
          .addChoices(...BRACKET_CHOICES)
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option
          .setName('limit')
          .setDescription(`How many to show (1-${MAX_LIMIT}).`)
          .setMinValue(1)
          .setMaxValue(MAX_LIMIT)
      )
      .addBooleanOption(option =>
        option
          .setName('this-realm-only')
          .setDescription('Only show teams from your realm.')
      );
    addGameOption(sub);
    addRegionOption(sub);
    return sub;
  })
  .addSubcommand(sub => {
    sub
      .setName('rank')
      .setDescription('Where a character sits on the ladder.')
      .addStringOption(option =>
        option.setName('character').setDescription('Character name.').setRequired(true)
      );
    addRealmOption(sub);
    addGameOption(sub);
    addRegionOption(sub);
    return sub;
  });

/** "#3  Butud-nightslayer — 2330 (62W/14L)" */
function formatEntry(entry, { showRealm = true } = {}) {
  const name = entry.character?.name ?? '?';
  const realm = entry.character?.realm?.slug ?? '';
  const stats = entry.season_match_statistics ?? {};
  const record =
    Number.isFinite(stats.won) && Number.isFinite(stats.lost)
      ? ` (${stats.won}W/${stats.lost}L)`
      : '';

  return `\`#${String(entry.rank).padStart(3)}\` **${name}**${showRealm && realm ? `-${realm}` : ''} — ${formatNumber(entry.rating)}${record}`;
}

function buildLadderEmbed({ entries, bracket, scope, seasonId, limit, realmFilter, total }) {
  const shown = entries.slice(0, limit);

  const embed = new EmbedBuilder()
    .setColor(ARENA_COLOR)
    .setTitle(`${bracket} Ladder — ${scope.label}`)
    .setDescription(
      shown.length > 0
        ? shown.map(entry => formatEntry(entry, { showRealm: !realmFilter })).join('\n')
        : 'Nobody is ranked in this bracket.'
    )
    .setFooter({
      text: realmFilter
        ? `Season ${seasonId} • ${formatNumber(entries.length)} ranked on ${realmFilter} of ${formatNumber(total)} total`
        : `Season ${seasonId} • ${formatNumber(total)} ranked`
    });

  return embed;
}

function buildRankEmbed({ characterName, realmSlug, results, scope, seasonId }) {
  const ranked = results.filter(result => result.entry);

  const embed = new EmbedBuilder()
    .setColor(ranked.length > 0 ? ARENA_COLOR : FALLBACK_COLOR)
    .setTitle(`Arena — ${characterName} (${scope.label})`);

  if (ranked.length === 0) {
    embed.setDescription(
      `**${characterName}** is not ranked in any bracket this season.\n` +
        'Rated arena games are needed to appear on a ladder — honor from world PvP ' +
        'and battlegrounds does not count.'
    );
  } else {
    embed.addFields(
      ranked.map(({ bracket, entry, total }) => {
        const stats = entry.season_match_statistics ?? {};
        const played = (stats.won ?? 0) + (stats.lost ?? 0);
        const winRate = played > 0 ? Math.round(((stats.won ?? 0) / played) * 100) : null;

        return {
          name: bracket,
          value:
            `Rating **${formatNumber(entry.rating)}**\n` +
            `Rank **#${formatNumber(entry.rank)}** of ${formatNumber(total)}\n` +
            `${stats.won ?? 0}W / ${stats.lost ?? 0}L${winRate === null ? '' : ` (${winRate}%)`}`,
          inline: true
        };
      })
    );
  }

  const unranked = results.filter(result => !result.entry).map(result => result.bracket);
  if (ranked.length > 0 && unranked.length > 0) {
    embed.addFields({ name: 'Unranked', value: unranked.join(', ') });
  }

  embed.setFooter({ text: `Season ${seasonId} • ${realmSlug}` });
  return embed;
}

async function showLadder(interaction, scope) {
  const bracket = interaction.options.getString('bracket');
  const limit = interaction.options.getInteger('limit') ?? DEFAULT_LIMIT;
  const thisRealmOnly = interaction.options.getBoolean('this-realm-only') ?? false;

  const seasonId = await getCurrentSeasonId({ region: scope.region, game: scope.game });

  if (seasonId === null) {
    await interaction.editReply('❌ No PvP season is available for this game version.');
    return;
  }

  const entries = await getLeaderboard(seasonId, bracket, {
    region: scope.region,
    game: scope.game
  });

  let filtered = entries;
  let realmFilter = null;

  if (thisRealmOnly) {
    const home = resolveRealmName(interaction);
    if (home) {
      const target = await resolveRealm(home, { region: scope.region, game: scope.game });
      realmFilter = target.slug;
      filtered = entries.filter(entry => entry.character?.realm?.slug === target.slug);
    }
  }

  await interaction.editReply({
    embeds: [
      buildLadderEmbed({
        entries: filtered,
        bracket,
        scope,
        seasonId,
        limit,
        realmFilter,
        total: entries.length
      })
    ]
  });
}

async function showRank(interaction, scope) {
  const characterName = interaction.options.getString('character');
  const realm = resolveRealmName(interaction);

  if (!realm) {
    await interaction.editReply(
      '❌ No realm given, and no default realm is configured. Pass the `realm` option.'
    );
    return;
  }

  const target = await resolveRealm(realm, { region: scope.region, game: scope.game });
  const seasonId = await getCurrentSeasonId({ region: scope.region, game: scope.game });

  if (seasonId === null) {
    await interaction.editReply('❌ No PvP season is available for this game version.');
    return;
  }

  // One cached fetch per bracket; the cache makes repeat lookups cheap.
  const results = [];
  for (const bracket of BRACKETS) {
    const entries = await getLeaderboard(seasonId, bracket, {
      region: scope.region,
      game: scope.game
    });
    const { entry, total } = findOnLadder(entries, characterName, target.slug);
    results.push({ bracket, entry, total });
  }

  await interaction.editReply({
    embeds: [
      buildRankEmbed({ characterName, realmSlug: target.slug, results, scope, seasonId })
    ]
  });
}

async function execute(interaction) {
  await interaction.deferReply();

  const scope = resolveScope(interaction);

  if (interaction.options.getSubcommand() === 'rank') {
    await showRank(interaction, scope);
    return;
  }

  await showLadder(interaction, scope);
}

module.exports = {
  data,
  help: 'Shows arena ladder standings, and where a character ranks.',
  category: 'WoW',
  buildLadderEmbed,
  buildRankEmbed,
  execute,
  formatEntry
};
