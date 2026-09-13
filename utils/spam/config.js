// utils/spam/config.js
// Spam settings, persisted to one small JSON file so /spam configure survives a
// restart. This is the bot's only persisted state; everything else is derived
// from the Blizzard API or held in memory.
//
// Every value is clamped on read and on write, so a hand-edited file cannot put
// the bot into a state where it bans on a hair trigger.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'spam.json');

const ACTIONS = ['ban', 'timeout'];

// Discord caps a timeout at 28 days.
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

const DEFAULTS = {
  enabled: false, // ships off; an admin turns it on deliberately
  alertChannelId: null,
  rateLimit: { count: 5, windowMs: 5000 },
  duplicateThreshold: 3,
  crossChannelThreshold: 2,
  duplicateWindowMs: 60000,
  mentionThreshold: 5,
  signalThreshold: 2,
  newAccountDays: 3,
  establishedDays: 30,
  action: 'ban',
  timeoutMs: 3600000,
  secondaryAction: 'timeout',
  secondaryTimeoutMs: 3600000,
  exemptRoleIds: [],
  exemptChannelIds: []
};

let cache = null;

function clampInt(value, { min, max, fallback }) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function normalizeAction(value, fallback) {
  const action = String(value ?? '').trim().toLowerCase();
  return ACTIONS.includes(action) ? action : fallback;
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];

  // Drop nullish before stringifying — String(null) is "null", which is truthy
  // and would otherwise be stored as a literal role id.
  return [
    ...new Set(
      value
        .filter(id => id !== null && id !== undefined)
        .map(id => String(id).trim())
        .filter(Boolean)
    )
  ];
}

function normalizeId(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

/** Applies defaults and clamps every field. Safe against arbitrary input. */
function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rateLimit = source.rateLimit && typeof source.rateLimit === 'object' ? source.rateLimit : {};

  return {
    enabled: Boolean(source.enabled),
    alertChannelId: normalizeId(source.alertChannelId),
    rateLimit: {
      count: clampInt(rateLimit.count, { min: 2, max: 50, fallback: DEFAULTS.rateLimit.count }),
      windowMs: clampInt(rateLimit.windowMs, {
        min: 1000,
        max: 60000,
        fallback: DEFAULTS.rateLimit.windowMs
      })
    },
    duplicateThreshold: clampInt(source.duplicateThreshold, {
      min: 2,
      max: 20,
      fallback: DEFAULTS.duplicateThreshold
    }),
    crossChannelThreshold: clampInt(source.crossChannelThreshold, {
      min: 2,
      max: 20,
      fallback: DEFAULTS.crossChannelThreshold
    }),
    duplicateWindowMs: clampInt(source.duplicateWindowMs, {
      min: 5000,
      max: 600000,
      fallback: DEFAULTS.duplicateWindowMs
    }),
    mentionThreshold: clampInt(source.mentionThreshold, {
      min: 2,
      max: 50,
      fallback: DEFAULTS.mentionThreshold
    }),
    signalThreshold: clampInt(source.signalThreshold, {
      min: 1,
      max: 10,
      fallback: DEFAULTS.signalThreshold
    }),
    newAccountDays: clampInt(source.newAccountDays, {
      min: 1,
      max: 365,
      fallback: DEFAULTS.newAccountDays
    }),
    establishedDays: clampInt(source.establishedDays, {
      min: 1,
      max: 365,
      fallback: DEFAULTS.establishedDays
    }),
    action: normalizeAction(source.action, DEFAULTS.action),
    timeoutMs: clampInt(source.timeoutMs, {
      min: 60000,
      max: MAX_TIMEOUT_MS,
      fallback: DEFAULTS.timeoutMs
    }),
    secondaryAction: normalizeAction(source.secondaryAction, DEFAULTS.secondaryAction),
    secondaryTimeoutMs: clampInt(source.secondaryTimeoutMs, {
      min: 60000,
      max: MAX_TIMEOUT_MS,
      fallback: DEFAULTS.secondaryTimeoutMs
    }),
    exemptRoleIds: normalizeIdList(source.exemptRoleIds),
    exemptChannelIds: normalizeIdList(source.exemptChannelIds)
  };
}

/**
 * Reads the config, caching it in memory. A missing file is normal (first run);
 * a corrupt one falls back to safe defaults rather than crashing the bot, since
 * failing closed here would mean no moderation at all.
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
    cache = normalizeConfig(DEFAULTS);
  }

  return cache;
}

/**
 * Merges changes in and writes them out. The write is atomic — a temp file plus
 * a rename — so an interrupted write cannot leave a half-written config behind.
 */
function saveConfig(changes = {}) {
  const next = normalizeConfig({ ...loadConfig(), ...changes });

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tempPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, CONFIG_PATH);

  cache = next;
  return next;
}

/** Drops the in-memory copy. Tests, and any future reload command. */
function clearConfigCache() {
  cache = null;
}

module.exports = {
  ACTIONS,
  CONFIG_PATH,
  DATA_DIR,
  DEFAULTS,
  MAX_TIMEOUT_MS,
  clearConfigCache,
  loadConfig,
  normalizeConfig,
  saveConfig
};
