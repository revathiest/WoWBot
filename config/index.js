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
 *   retail       -> profile-us            (modern WoW)
 *   anniversary  -> profile-classicann-us (TBC Anniversary: Dreamscythe,
 *                                          Nightslayer, Maladath, Thunderstrike,
 *                                          Spineshatter)
 *   classic      -> profile-classic-us    (progression Classic, currently the
 *                                          Mists of Pandaria track)
 *   classic-era  -> profile-classic1x-us  (permanent vanilla, incl. Hardcore)
 *
 * `classicann` is undocumented in the API reference and was not discoverable by
 * probing — an invalid namespace and an unauthorised one both return an identical
 * generic 403. It came from Blizzard's own API forum. Do not assume a namespace
 * is absent because it 403s.
 */
const GAMES = {
  retail: { label: 'Retail', infix: null },
  anniversary: { label: 'TBC Anniversary', infix: 'classicann' },
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

/**
 * Commands that were open to everyone before the server was locked down.
 *
 * This list is the UNDO. While `adminOnly` is on, every command requires Manage
 * Server regardless of what it declares for itself; turning it off restores
 * each command's own permissions, and these are the ones that go back to being
 * public. Recorded here so that restoring is reading a list rather than
 * reconstructing one from memory.
 *
 * Two of them are public commands with admin-only SUBCOMMANDS, which keep their
 * own gating either way: /help (setup, unlock) and /iam (manage).
 */
const PUBLIC_COMMANDS = [
  'arena',
  'audit',
  'character',
  'guild',
  'help',
  'iam',
  'item',
  'mythicplus',
  'realm',
  'realms',
  'token'
];

/**
 * Locks every command to Manage Server.
 *
 * On by default while the bot is being rolled out. Set `ADMIN_ONLY=false` in
 * the environment to hand the commands in PUBLIC_COMMANDS back to everybody —
 * that is the whole revert.
 */
function readAdminOnly(env = process.env) {
  const value = String(env.ADMIN_ONLY ?? '').trim().toLowerCase();
  if (value === 'false' || value === '0' || value === 'no') return false;
  return true;
}

function normalizeRegion(value) {
  const region = String(value ?? '').trim().toLowerCase();
  return REGIONS.includes(region) ? region : null;
}

function readConfig(env = process.env) {
  return {
    discord: {
      // While true, every command requires Manage Server. See PUBLIC_COMMANDS.
      adminOnly: readAdminOnly(env),
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
      game: normalizeGame(env.BLIZZARD_GAME) ?? DEFAULT_GAME,
      // Optional home realm, so commands can omit `realm` entirely.
      realm: (env.BLIZZARD_REALM ?? '').trim() || null
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
  PUBLIC_COMMANDS,
  REGIONS,
  GAMES,
  DEFAULT_REGION,
  DEFAULT_LOCALE,
  DEFAULT_GAME,
  buildNamespace,
  normalizeGame,
  normalizeRegion,
  readAdminOnly,
  readConfig,
  validateConfig
};
