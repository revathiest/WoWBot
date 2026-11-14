// utils/adminRoles/config.js
// Extra roles that count as admin, on top of actual Manage Server. Persisted
// to one small JSON file, keyed by guild, so the list survives a restart.
//
// This only ever widens who an admin check accepts — it is additive, never a
// replacement for the Manage Server/Administrator check, and /adminrole
// itself (the command that edits this list) always requires real Manage
// Server rather than consulting this list, so a granted role can never grant
// further roles.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'adminRoles.json');

let cache = null;

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value
        .filter(id => id !== null && id !== undefined)
        .map(id => String(id).trim())
        .filter(Boolean)
    )
  ];
}

/** Drops unknown keys and non-array values; every guild gets a clean string list. */
function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const next = {};

  for (const [guildId, roleIds] of Object.entries(source)) {
    const id = String(guildId ?? '').trim();
    if (!id) continue;

    const list = normalizeIdList(roleIds);
    if (list.length > 0) next[id] = list;
  }

  return next;
}

/**
 * Reads the config, caching it in memory. A missing file is normal (no admin
 * roles configured yet); a corrupt one falls back to an empty map rather than
 * crashing the bot.
 */
function loadConfig() {
  if (cache) return cache;

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    cache = normalizeConfig(JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not read ${CONFIG_PATH}, using defaults: ${err.message}`);
    }
    cache = {};
  }

  return cache;
}

/** Merges changes in and writes them out atomically. */
function saveConfig(changes = {}) {
  const next = normalizeConfig({ ...loadConfig(), ...changes });

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tempPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, CONFIG_PATH);

  cache = next;
  return next;
}

/** The admin role ids configured for one guild. */
function getRoleIds(guildId) {
  const id = String(guildId ?? '').trim();
  if (!id) return [];

  return loadConfig()[id] ?? [];
}

/** Adds a role to a guild's list. Returns the resulting list. */
function addRole(guildId, roleId) {
  const id = String(guildId ?? '').trim();
  const role = String(roleId ?? '').trim();
  if (!id || !role) return getRoleIds(guildId);

  const next = saveConfig({ [id]: [...getRoleIds(id), role] });
  return next[id] ?? [];
}

/** Removes a role from a guild's list. Returns the resulting list. */
function removeRole(guildId, roleId) {
  const id = String(guildId ?? '').trim();
  const role = String(roleId ?? '').trim();
  if (!id || !role) return getRoleIds(guildId);

  const next = saveConfig({ [id]: getRoleIds(id).filter(existing => existing !== role) });
  return next[id] ?? [];
}

/** Drops the in-memory copy. Tests, and any future reload command. */
function clearConfigCache() {
  cache = null;
}

module.exports = {
  CONFIG_PATH,
  DATA_DIR,
  addRole,
  clearConfigCache,
  getRoleIds,
  loadConfig,
  normalizeConfig,
  removeRole,
  saveConfig
};
