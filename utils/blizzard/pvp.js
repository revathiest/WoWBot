// utils/blizzard/pvp.js
// Arena ladders and per-character PvP standing.
//
// Leaderboards are large — a single TBC Anniversary bracket returns ~5,000
// entries — and finding one character means scanning the whole list. They are
// therefore cached briefly, following the pattern in realms.js: an absolute
// expiry compared against Date.now(), never a timer, so tests can fast-forward.

const { request } = require('./client');
const { DEFAULT_GAME, DEFAULT_REGION } = require('../../config');

// Ladders move slowly; a few minutes of staleness is invisible to users and
// saves pulling megabytes for every lookup.
const LEADERBOARD_TTL_MS = 10 * 60 * 1000;

// The brackets TBC actually has. The API also lists retail-only ones
// (blitz-overall, shuffle-overall, rbg) which are empty here.
const BRACKETS = ['2v2', '3v3', '5v5'];

const leaderboardCache = new Map();

function cacheKey(region, game, seasonId, bracket) {
  return `${region}:${game}:${seasonId}:${bracket}`;
}

function clearPvpCache() {
  leaderboardCache.clear();
}

/** Season list plus which one is current. The current id is not hardcodable. */
function getPvpSeasonIndex(options = {}) {
  return request('/data/wow/pvp-season/index', { ...options, namespace: 'dynamic' });
}

/** Resolves the current season id, so commands never hardcode one. */
async function getCurrentSeasonId(options = {}) {
  const index = await getPvpSeasonIndex(options);
  const current = index?.current_season?.id;

  if (Number.isFinite(current)) return current;

  // Fall back to the highest listed season if `current_season` is missing.
  const ids = (index?.seasons ?? []).map(season => Number(season.id)).filter(Number.isFinite);
  return ids.length > 0 ? Math.max(...ids) : null;
}

/** One bracket's ladder, cached. */
async function getLeaderboard(seasonId, bracket, options = {}) {
  const region = options.region ?? DEFAULT_REGION;
  const game = options.game ?? DEFAULT_GAME;
  const key = cacheKey(region, game, seasonId, bracket);

  const cached = leaderboardCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;

  const board = await request(`/data/wow/pvp-season/${seasonId}/pvp-leaderboard/${bracket}`, {
    ...options,
    region,
    game,
    namespace: 'dynamic'
  });

  const entries = board?.entries ?? [];
  leaderboardCache.set(key, { expiresAt: Date.now() + LEADERBOARD_TTL_MS, entries });

  return entries;
}

/** Honorable kills and the brackets a character is ranked in. */
function getCharacterPvpSummary(realmSlug, characterName, options = {}) {
  return request(`/profile/wow/character/${realmSlug}/${characterName}/pvp-summary`, {
    ...options,
    namespace: 'profile'
  });
}

/** One bracket's standing for a character. */
function getCharacterPvpBracket(realmSlug, characterName, bracket, options = {}) {
  return request(`/profile/wow/character/${realmSlug}/${characterName}/pvp-bracket/${bracket}`, {
    ...options,
    namespace: 'profile'
  });
}

/** Finds a character on a ladder. Returns the entry plus the ladder size. */
function findOnLadder(entries, characterName, realmSlug) {
  const name = String(characterName ?? '').toLowerCase();

  const entry = entries.find(
    item =>
      item.character?.name?.toLowerCase() === name &&
      (!realmSlug || item.character?.realm?.slug === realmSlug)
  );

  return { entry: entry ?? null, total: entries.length };
}

module.exports = {
  BRACKETS,
  LEADERBOARD_TTL_MS,
  clearPvpCache,
  findOnLadder,
  getCharacterPvpBracket,
  getCharacterPvpSummary,
  getCurrentSeasonId,
  getLeaderboard,
  getPvpSeasonIndex
};
