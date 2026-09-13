// config/index.js
// Central place for environment-derived settings, so nothing else reads process.env directly.

const REGIONS = ['us', 'eu', 'kr', 'tw'];

const DEFAULT_REGION = 'us';
const DEFAULT_LOCALE = 'en_US';

/**
 * The three WoW flavours Blizzard exposes, and the namespace infix each one uses.
 * Verified by probing: only these exist — `classic2x`, `classictbc`, `classicwlk`
 * and similar all return 403.
 *
 *   retail       -> profile-us          (modern WoW)
 *   classic      -> profile-classic-us  (progression Classic, incl. Burning
 *                                        Crusade Anniversary realms like Maladath)
 *   classic-era  -> profile-classic1x-us (permanent vanilla, incl. Hardcore)
 */
const GAMES = {
  retail: { label: 'Retail', infix: null },
  classic: { label: 'Classic', infix: 'classic' },
  'classic-era': { label: 'Classic Era', infix: 'classic1x' }
};

const DEFAULT_GAME = 'retail';

function normalizeGame(value) {
  const game = String(value ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(GAMES, game) ? game : null;
}

/** Builds the full namespace header value, e.g. ('dynamic','classic','us') -> 'dynamic-classic-us'. */
function buildNamespace(namespace, game, region) {
  const infix = GAMES[game ?? DEFAULT_GAME]?.infix;
  return infix ? `${namespace}-${infix}-${region}` : `${namespace}-${region}`;
}

function normalizeRegion(value) {
  const region = String(value ?? '').trim().toLowerCase();
  return REGIONS.includes(region) ? region : null;
}

function readConfig(env = process.env) {
  return {
    discord: {
      token: env.DISCORD_TOKEN ?? '',
      applicationId: env.APPLICATION_ID ?? '',
      // Optional: when present, commands register to this guild only (instant updates).
      guildId: (env.GUILD_ID ?? '').trim() || null
    },
    blizzard: {
      clientId: env.BLIZZARD_CLIENT_ID ?? '',
      clientSecret: env.BLIZZARD_CLIENT_SECRET ?? '',
      region: normalizeRegion(env.BLIZZARD_REGION) ?? DEFAULT_REGION,
      locale: (env.BLIZZARD_LOCALE ?? '').trim() || DEFAULT_LOCALE,
      game: normalizeGame(env.BLIZZARD_GAME) ?? DEFAULT_GAME
    }
  };
}

// Returns a list of human-readable problems; empty means good to launch.
function validateConfig(config = readConfig()) {
  const problems = [];

  if (!config.discord.token) problems.push('DISCORD_TOKEN is not set.');
  if (!config.discord.applicationId) problems.push('APPLICATION_ID is not set.');
  if (!config.blizzard.clientId) problems.push('BLIZZARD_CLIENT_ID is not set.');
  if (!config.blizzard.clientSecret) problems.push('BLIZZARD_CLIENT_SECRET is not set.');

  return problems;
}

module.exports = {
  REGIONS,
  GAMES,
  DEFAULT_REGION,
  DEFAULT_LOCALE,
  DEFAULT_GAME,
  buildNamespace,
  normalizeGame,
  normalizeRegion,
  readConfig,
  validateConfig
};
