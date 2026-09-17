// utils/nicknames/config.js
// Whether the bot renames people to match their main character.
//
// Off until switched on, like every other feature that changes something about
// a member rather than just reading it. Renaming somebody is visible to the
// whole server and is not something to start doing by default.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'nicknames.json');

const DEFAULTS = {
  enabled: false,
  lastSyncAt: null
};

let cache = null;

function normalizeTimestamp(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};

  return {
    enabled: Boolean(source.enabled),
    lastSyncAt: normalizeTimestamp(source.lastSyncAt)
  };
}

function loadConfig() {
  if (cache) return cache;

  try {
    cache = normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not read ${CONFIG_PATH}, using defaults: ${err.message}`);
    }
    // Failing to "off" means nobody gets renamed unexpectedly.
    cache = normalizeConfig(DEFAULTS);
  }

  return cache;
}

function saveConfig(changes = {}) {
  const next = normalizeConfig({ ...loadConfig(), ...changes });

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tempPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, CONFIG_PATH);

  cache = next;
  return next;
}

function clearConfigCache() {
  cache = null;
}

module.exports = { CONFIG_PATH, DEFAULTS, clearConfigCache, loadConfig, normalizeConfig, saveConfig };
