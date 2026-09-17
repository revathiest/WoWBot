// utils/audit/config.js
// Where the bot writes a record of what it did.
//
// Distinct from the alert channels the spam detector and the onboarding sweep
// already have: those carry the full reasoning behind one decision, for review.
// This is the flat, chronological "what happened" feed, and it covers every
// command and every action the bot takes on its own.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'audit.json');

/**
 * How much to record.
 *
 *   all    every command and button, plus everything the bot does unprompted
 *   admin  configuration and moderation only — skips ordinary lookups like
 *          /character, which are the bulk of the traffic and rarely interesting
 *   off    nothing
 */
const VERBOSITY = ['all', 'admin', 'off'];

// Categories whose commands count as administrative for `admin` verbosity.
const ADMIN_CATEGORIES = ['Admin'];

const DEFAULTS = {
  enabled: false,
  channelId: null,
  verbosity: 'all'
};

let cache = null;

function normalizeId(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

function normalizeVerbosity(value) {
  const verbosity = String(value ?? '').trim().toLowerCase();
  return VERBOSITY.includes(verbosity) ? verbosity : DEFAULTS.verbosity;
}

function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};

  return {
    enabled: Boolean(source.enabled),
    channelId: normalizeId(source.channelId),
    verbosity: normalizeVerbosity(source.verbosity)
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

/** Whether an entry of this kind should be written at all. */
function shouldLog(entry, config = loadConfig()) {
  if (!config.enabled || !config.channelId || config.verbosity === 'off') return false;
  if (config.verbosity === 'all') return true;

  // `admin`: anything the bot did on its own is always interesting, and so is
  // anything from an administrative command.
  return entry.automatic === true || ADMIN_CATEGORIES.includes(entry.category);
}

function clearConfigCache() {
  cache = null;
}

module.exports = {
  ADMIN_CATEGORIES,
  CONFIG_PATH,
  DEFAULTS,
  VERBOSITY,
  clearConfigCache,
  loadConfig,
  normalizeConfig,
  saveConfig,
  shouldLog
};
