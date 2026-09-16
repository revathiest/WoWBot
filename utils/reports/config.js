// utils/reports/config.js
// Weekly-report settings, persisted next to the spam config and following the
// same rules: defaults applied and every value clamped on both read and write,
// so a hand-edited file cannot put the scheduler into a strange state.
//
// "Guild" is unavoidably overloaded here. `channelId` and the file itself belong
// to the Discord server; `guilds` is the list of WOW guilds being reported on.
// One Discord server commonly tracks several.

const fs = require('fs');
const path = require('path');

const { normalizeGame, normalizeRegion, readConfig } = require('../../config');
const { realmMatchKey } = require('../wow');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'reports.json');

// Sunday-first, matching JavaScript's getUTCDay().
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// A roster plus a honorable-kill lookup per member is a few hundred API calls
// per guild. That is fine weekly and fine on demand, but it is not something to
// let grow without a ceiling.
const MAX_TRACKED_GUILDS = 10;

const DEFAULTS = {
  enabled: false, // ships off; an admin turns it on once a channel is set
  channelId: null,
  dayOfWeek: 1, // Monday
  hour: 18, // UTC — see the note on scheduling in scheduler.js
  lastPostedAt: null,
  guilds: []
};

let cache = null;

function clampInt(value, { min, max, fallback }) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function normalizeId(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

function normalizeTimestamp(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * A stable identity for a tracked guild, used to key its snapshot file and to
 * reject duplicates. Realm and guild names are folded the same forgiving way
 * realm input is, so "Apex" and "apex " are one entry rather than two.
 */
function guildKey({ name, realm, region, game }) {
  return [
    normalizeRegion(region) ?? 'us',
    normalizeGame(game) ?? 'retail',
    realmMatchKey(realm),
    realmMatchKey(name)
  ].join(':');
}

/** One tracked WoW guild. Returns null when it is too malformed to keep. */
function normalizeGuild(raw, config = readConfig()) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const name = String(source.name ?? '').trim();
  const realm = String(source.realm ?? '').trim() || config.blizzard.realm;

  if (!name || !realm) return null;

  return {
    name,
    realm,
    region: normalizeRegion(source.region) ?? config.blizzard.region,
    game: normalizeGame(source.game) ?? config.blizzard.game,
    // Optional per-guild override; falls back to the server-wide channel.
    channelId: normalizeId(source.channelId)
  };
}

function normalizeGuilds(value, config = readConfig()) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const guilds = [];

  for (const raw of value) {
    const guild = normalizeGuild(raw, config);
    if (!guild) continue;

    const key = guildKey(guild);
    if (seen.has(key)) continue;

    seen.add(key);
    guilds.push(guild);

    if (guilds.length >= MAX_TRACKED_GUILDS) break;
  }

  return guilds;
}

function normalizeConfig(raw = {}, config = readConfig()) {
  const source = raw && typeof raw === 'object' ? raw : {};

  return {
    enabled: Boolean(source.enabled),
    channelId: normalizeId(source.channelId),
    dayOfWeek: clampInt(source.dayOfWeek, { min: 0, max: 6, fallback: DEFAULTS.dayOfWeek }),
    hour: clampInt(source.hour, { min: 0, max: 23, fallback: DEFAULTS.hour }),
    lastPostedAt: normalizeTimestamp(source.lastPostedAt),
    guilds: normalizeGuilds(source.guilds, config)
  };
}

/**
 * Reads the config, caching it in memory. A missing file is the normal first
 * run. A corrupt one falls back to defaults — which means reporting is off
 * until an admin configures it, the safe direction to fail for something that
 * posts to a channel.
 */
function loadConfig() {
  if (cache) return cache;

  try {
    cache = normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not read ${CONFIG_PATH}, using defaults: ${err.message}`);
    }
    cache = normalizeConfig(DEFAULTS);
  }

  return cache;
}

/** Merges changes in and writes them out atomically, as spam config does. */
function saveConfig(changes = {}) {
  const next = normalizeConfig({ ...loadConfig(), ...changes });

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tempPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, CONFIG_PATH);

  cache = next;
  return next;
}

/**
 * Adds a guild to the tracked list.
 *
 * @returns {{added: boolean, reason: string|null, config: object}}
 */
function trackGuild(raw) {
  const guild = normalizeGuild(raw);

  if (!guild) {
    return { added: false, reason: 'incomplete', config: loadConfig() };
  }

  const current = loadConfig();
  const key = guildKey(guild);

  if (current.guilds.some(entry => guildKey(entry) === key)) {
    return { added: false, reason: 'duplicate', config: current };
  }

  if (current.guilds.length >= MAX_TRACKED_GUILDS) {
    return { added: false, reason: 'full', config: current };
  }

  return { added: true, reason: null, config: saveConfig({ guilds: [...current.guilds, guild] }) };
}

/**
 * Removes a guild by name, optionally narrowed by realm.
 *
 * The removed entries come back so the caller can delete their snapshots — an
 * untracked guild should not leave a week of history behind for a later
 * re-track to diff against.
 */
function untrackGuild({ name, realm = null }) {
  const current = loadConfig();
  const nameKey = realmMatchKey(name);
  const realmKey = realm ? realmMatchKey(realm) : null;

  const matches = guild =>
    realmMatchKey(guild.name) === nameKey &&
    (realmKey === null || realmMatchKey(guild.realm) === realmKey);

  const removed = current.guilds.filter(matches);

  if (removed.length === 0) {
    return { removed: false, removedGuilds: [], config: current };
  }

  return {
    removed: true,
    removedGuilds: removed,
    config: saveConfig({ guilds: current.guilds.filter(guild => !matches(guild)) })
  };
}

/** Where a guild's report should be posted: its own channel, or the default. */
function channelFor(guild, config = loadConfig()) {
  return guild?.channelId ?? config.channelId;
}

/** Drops the in-memory copy. Tests, and any future reload command. */
function clearConfigCache() {
  cache = null;
}

module.exports = {
  CONFIG_PATH,
  DATA_DIR,
  DAYS,
  DEFAULTS,
  MAX_TRACKED_GUILDS,
  channelFor,
  clearConfigCache,
  guildKey,
  loadConfig,
  normalizeConfig,
  normalizeGuild,
  saveConfig,
  trackGuild,
  untrackGuild
};
