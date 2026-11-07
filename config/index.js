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
 * probing — it came from Blizzard's own API forum. Do not assume a namespace is
 * absent because it 403s.
 *
 * A 403 and a 404 do NOT mean the same thing, though, which is worth knowing
 * before concluding anything from a probe (measured 2026-11-06):
 *
 *   403 BLZWEBAPI00000403  the namespace is not recognised, or not ours to read.
 *                          Returned for `zzqqxxnonsense`, `classic2x`,
 *                          `classictbc`, `era`, `vanilla`, `hardcore`, and for
 *                          omitting the parameter entirely.
 *   404 BLZWEBAPI00000404  the namespace IS accepted; that path has no document
 *                          in it. `dynamic-us` plus a bogus realm slug 404s too.
 *
 * So a 404 is positive evidence that a namespace exists. A 403 remains
 * ambiguous.
 */
const GAMES = {
  retail: { label: 'Retail', infix: null },
  anniversary: { label: 'TBC Anniversary', infix: 'classicann' },
  classic: { label: 'Classic', infix: 'classic' },
  'classic-era': { label: 'Classic Era', infix: 'classic1x' },
  // Classic Forever is addressed differently from every other flavour: no
  // realms, and three features Blizzard does not serve. Read REALMLESS_GAMES
  // and UNSUPPORTED below before writing anything that takes a realm.
  forever: { label: 'Classic Forever', infix: 'forever' }
};

const DEFAULT_GAME = 'retail';

/**
 * Flavours Blizzard answers for, but that are NOT offered to users yet.
 *
 * Empty on purpose, and kept rather than deleted: `forever` lived here while it
 * was unreachable, and the next unreleased flavour will too. An entry here is
 * addressable by `buildNamespace` but refused by `normalizeGame`, which is the
 * difference between "the bot can probe it" and "a user can pick it".
 */
const PENDING_GAMES = {};

// Everything `buildNamespace` can address, released or not.
const ALL_FLAVOURS = { ...GAMES, ...PENDING_GAMES };

/**
 * Flavours where a character has NO realm.
 *
 * Classic Forever replaced realms with RULESETS. Measured 2026-11-06 against the
 * live API, and corroborated on Blizzard's API forum:
 *
 *   - A character is ONE path segment, `{name}-{surname}` lowercased:
 *     `/profile/wow/character/judgement-judy` → 200, with `realm: null`, a
 *     `surname` field, and a `ruleset` of `{ id, name }`.
 *   - A guild is one segment too: `/data/wow/guild/circle-of-lore` → 200, and
 *     `/roster` under it works.
 *   - `/data/wow/ruleset/index` → 200 with four rulesets — 1 PvP, 2 Normal,
 *     3 Roleplay, 15 Roleplay PvP — each carrying a `status` and an `auctions`
 *     link. These are the nearest thing to a realm, and what /realm and /realms
 *     report for this flavour.
 *   - `/data/wow/realm/index` and `/data/wow/connected-realm/index` 404, while
 *     `/data/wow/search/realm` returns 200 with `pageCount: 0`. The realm
 *     collection is live and permanently EMPTY, not unpublished. Nothing should
 *     wait for it to fill.
 *
 * Why a Set and not a flag on the GAMES entry: every realm-taking path has to
 * ask this, and a Set keeps the answer one import away from code that has no
 * other reason to read a flavour's metadata.
 */
const REALMLESS_GAMES = new Set(['forever']);

/** Whether characters in this flavour are addressed without a realm. */
function isRealmless(game) {
  return REALMLESS_GAMES.has(String(game ?? '').trim().toLowerCase());
}

/**
 * Features a flavour's API does not serve, and why.
 *
 * The text is user-facing — it is what a command replies instead of failing —
 * so it has to explain rather than just decline. All three below are properties
 * of the game, not gaps Blizzard will fill: 1.60.1 is vanilla, which had no WoW
 * Token, no arenas and no Mythic+.
 */
const UNSUPPORTED = {
  forever: {
    token:
      'Classic Forever has no WoW Token. It runs on patch 1.60.1 (vanilla), and ' +
      'Blizzard serves no token endpoint for it.',
    arena:
      'Classic Forever has no arenas. Arena arrived in The Burning Crusade, so ' +
      'there are no PvP seasons or leaderboards — only the vanilla honour system.',
    mythicplus:
      'Classic Forever has no Mythic+. Keystones arrived in Legion, so the ' +
      'endpoint reports a period id and nothing else.'
  }
};

/**
 * Why `feature` cannot work for `game`, or null when it can.
 *
 * Returns the reason rather than a boolean so that a command which cannot answer
 * says why in the same breath — which keeps the explanation next to the fact.
 */
function unsupportedReason(game, feature) {
  const key = String(game ?? '').trim().toLowerCase();
  return UNSUPPORTED[key]?.[feature] ?? null;
}

function normalizeGame(value) {
  const game = String(value ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(GAMES, game) ? game : null;
}

/**
 * Builds the full namespace header value, e.g. ('dynamic','classic','us') ->
 * 'dynamic-classic-us'. Resolves PENDING_GAMES too, so the watcher can reach a
 * namespace that is not a selectable game version.
 */
function buildNamespace(namespace, game, region) {
  const infix = ALL_FLAVOURS[game ?? DEFAULT_GAME]?.infix;
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

// Where the namespace watcher posts. A name, not an id, so a fresh deployment
// needs no configuration step to start reporting.
const DEFAULT_WATCH_CHANNEL = 'bot-activity-log';

// Six hours. An unreleased namespace going live is a thing that happens on
// Blizzard's schedule, measured in weeks, so polling harder buys nothing.
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
  PUBLIC_COMMANDS,
  REGIONS,
  GAMES,
  PENDING_GAMES,
  REALMLESS_GAMES,
  UNSUPPORTED,
  DEFAULT_REGION,
  DEFAULT_LOCALE,
  DEFAULT_GAME,
  DEFAULT_WATCH_CHANNEL,
  DEFAULT_WATCH_INTERVAL_MS,
  MIN_WATCH_INTERVAL_MS,
  buildNamespace,
  normalizeGame,
  normalizeRegion,
  isRealmless,
  readAdminOnly,
  readFlag,
  unsupportedReason,
  readConfig,
  validateConfig
};
