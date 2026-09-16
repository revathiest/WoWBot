// utils/onboarding/config.js
// Settings for the onboarding sweep: kicking members who never pick a role.
//
// Same rules as the other stores — defaults applied and every value clamped on
// read and on write, so a hand-edited file cannot turn this into something that
// empties the server. That matters more here than anywhere else in the project,
// because this is the only feature that removes people on a timer rather than
// in response to something they did.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'onboarding.json');

// A week is the point of the feature, but a server that wants three days or a
// month should not have to edit code. Below a day is almost certainly a mistake.
const MIN_GRACE_DAYS = 1;
const MAX_GRACE_DAYS = 90;

/**
 * The most members one sweep may remove.
 *
 * A misconfiguration — a wrong grace period, an auto-role bot that stops
 * working — should cost a handful of people, not the whole server. When the cap
 * is hit the sweep stops and says so in the alert channel, so a real problem
 * surfaces as a message rather than as an empty member list.
 */
const MAX_KICKS_PER_SWEEP = 10;

const DEFAULTS = {
  enabled: false, // ships off, and enabling is a deliberate two-step
  // The cutoff. Nobody who joined before this instant is ever kicked, which is
  // what makes switching the feature on safe: it cannot act retroactively on
  // people who have been in the server for months.
  enabledAt: null,
  graceDays: 7,
  // How long after joining to send the reminder DM. Clamped below graceDays on
  // write, since a warning after the kick is no warning at all.
  warnAfterDays: 5,
  alertChannelId: null,
  // Optional. When set, the reminder DM points people straight at the role
  // picker; without it the DM can only tell them to look around the server.
  roleChannelId: null,
  lastSweepAt: null
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

function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const graceDays = clampInt(source.graceDays, {
    min: MIN_GRACE_DAYS,
    max: MAX_GRACE_DAYS,
    fallback: DEFAULTS.graceDays
  });

  return {
    enabled: Boolean(source.enabled),
    enabledAt: normalizeTimestamp(source.enabledAt),
    graceDays,
    // A reminder must land before the kick, or nobody is ever actually warned.
    warnAfterDays: clampInt(source.warnAfterDays, {
      min: 0,
      max: Math.max(graceDays - 1, 0),
      fallback: Math.min(DEFAULTS.warnAfterDays, Math.max(graceDays - 1, 0))
    }),
    alertChannelId: normalizeId(source.alertChannelId),
    roleChannelId: normalizeId(source.roleChannelId),
    lastSweepAt: normalizeTimestamp(source.lastSweepAt)
  };
}

/**
 * Reads the config, caching it. A missing file is the normal first run; a
 * corrupt one falls back to defaults, which means DISABLED — the only safe
 * direction to fail for something that removes members.
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

/** Merges changes in and writes them atomically. */
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
 * Switches the sweep on, stamping the cutoff.
 *
 * The stamp is refreshed on every off-to-on transition rather than kept from
 * the first time. That grants an amnesty to anyone who joined while the feature
 * was off, which is the safe direction: re-enabling can surprise an admin by
 * doing nothing, but never by kicking somebody they did not expect.
 */
function enable(now = Date.now()) {
  return saveConfig({ enabled: true, enabledAt: now });
}

function disable() {
  return saveConfig({ enabled: false });
}

function clearConfigCache() {
  cache = null;
}

module.exports = {
  CONFIG_PATH,
  DATA_DIR,
  DEFAULTS,
  MAX_GRACE_DAYS,
  MAX_KICKS_PER_SWEEP,
  MIN_GRACE_DAYS,
  clearConfigCache,
  disable,
  enable,
  loadConfig,
  normalizeConfig,
  saveConfig
};
