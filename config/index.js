// config/index.js
// Central place for environment-derived settings, so nothing else reads process.env directly.
//
// This bot serves exactly one WoW flavour: Classic Forever, patch 1.60.1.
// There is no `game` picker and no realm concept anywhere in here — Forever
// has neither. See AGENTS.md ("Classic Forever") for what that namespace
// actually serves.

const REGIONS = ['us', 'eu', 'kr', 'tw'];

const DEFAULT_REGION = 'us';
const DEFAULT_LOCALE = 'en_US';

// The one namespace infix this bot ever uses. Kept as a named constant rather
// than inlined so a reader of `buildNamespace` sees why it never varies.
const GAME_INFIX = 'forever';

/**
 * Builds the full namespace header value, e.g. ('dynamic', 'us') ->
 * 'dynamic-forever-us'.
 */
function buildNamespace(namespace, region) {
  return `${namespace}-${GAME_INFIX}-${region}`;
}

/**
 * Locks every command to Manage Server.
 *
 * On by default while the bot is being rolled out. While it is on, every
 * command requires Manage Server regardless of what it declares for itself.
 * Set `ADMIN_ONLY=false` in the environment to restore each command's own
 * declared permissions instead — public for most, since only a few (/report,
 * /ticket, /auditlog, /autokick, /spam) declare their own Manage Server
 * restriction. That is the whole revert.
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

// Where the namespace watcher posts. A name, not an id, so a fresh deployment
// needs no configuration step to start reporting.
const DEFAULT_WATCH_CHANNEL = 'bot-activity-log';

// Six hours. A regression in an endpoint this bot depends on is a thing that
// would be noticed within a day either way, so polling harder buys nothing.
const DEFAULT_WATCH_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Below this the poll is just noise against someone else's API quota.
const MIN_WATCH_INTERVAL_MS = 15 * 60 * 1000;

/** Reads a boolean-ish environment value, keeping `fallback` when it is unset. */
function readFlag(value, fallback) {
  const text = String(value ?? '').trim().toLowerCase();

  if (text === '') return fallback;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  if (['true', '1', 'yes', 'on'].includes(text)) return true;

  return fallback;
}

function readWatchInterval(value) {
  const minutes = Number(String(value ?? '').trim());

  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_WATCH_INTERVAL_MS;

  return Math.max(minutes * 60 * 1000, MIN_WATCH_INTERVAL_MS);
}

function readConfig(env = process.env) {
  return {
    discord: {
      // While true, every command requires Manage Server. See readAdminOnly.
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
      locale: (env.BLIZZARD_LOCALE ?? '').trim() || DEFAULT_LOCALE
    },
    namespaceWatch: {
      enabled: readFlag(env.NAMESPACE_WATCH, true),
      // A channel NAME (resolved per guild) or a raw channel id. Named rather
      // than id-configured because this is a developer-facing notice, not a
      // feature an admin sets up with a slash command.
      channel: (env.NAMESPACE_WATCH_CHANNEL ?? '').trim() || DEFAULT_WATCH_CHANNEL,
      intervalMs: readWatchInterval(env.NAMESPACE_WATCH_INTERVAL_MINUTES),
      // A real `{name}-{surname}` slug for the character check. There is no
      // sane default: a name nobody owns 404s under a working namespace just as
      // it does under a broken one, so an invented character would report the
      // profile API as dead. Unset means that one check is skipped.
      character: (env.NAMESPACE_WATCH_CHARACTER ?? '').trim().toLowerCase() || null
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
  GAME_INFIX,
  DEFAULT_REGION,
  DEFAULT_LOCALE,
  DEFAULT_WATCH_CHANNEL,
  DEFAULT_WATCH_INTERVAL_MS,
  MIN_WATCH_INTERVAL_MS,
  buildNamespace,
  normalizeRegion,
  readAdminOnly,
  readFlag,
  readConfig,
  validateConfig
};
