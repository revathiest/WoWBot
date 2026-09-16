// utils/onboarding/state.js
// Who has already been sent the "pick a role" reminder.
//
// This has to survive a restart. The sweep runs every few minutes, and without
// a record of who was warned, a bot that restarts twice an hour would DM the
// same person twice an hour — which is worse than not warning them at all.
//
// It holds Discord user ids and nothing else, and it self-prunes: every sweep
// passes in the set of members still under consideration, and anyone who has
// since picked a role, left, or been kicked is dropped. Nothing accumulates.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'onboarding-warned.json');

let cache = null;

/** `{ id: warnedAt }`, dropping anything that is not a usable pair. */
function normalizeState(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const warned = {};

  for (const [userId, warnedAt] of Object.entries(source)) {
    const id = String(userId ?? '').trim();
    const at = Number(warnedAt);

    if (id && Number.isFinite(at) && at > 0) warned[id] = at;
  }

  return warned;
}

function loadWarned() {
  if (cache) return cache;

  try {
    cache = normalizeState(JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not read ${STATE_PATH}, treating it as empty: ${err.message}`);
    }
    // Failing to empty means someone may get a second reminder. That is the
    // harmless direction — the alternative would be skipping the warning and
    // going straight to a kick.
    cache = {};
  }

  return cache;
}

function saveWarned(warned) {
  const next = normalizeState(warned);

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tempPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, STATE_PATH);

  cache = next;
  return next;
}

function wasWarned(userId) {
  return Object.prototype.hasOwnProperty.call(loadWarned(), String(userId ?? '').trim());
}

/**
 * Records reminders and drops everyone no longer being tracked, in one write.
 *
 * @param {string[]} warnedIds  Members reminded on this sweep.
 * @param {string[]} keepIds    Members still awaiting a role; everyone else is pruned.
 */
function recordSweep({ warnedIds = [], keepIds = [], now = Date.now() } = {}) {
  const current = loadWarned();
  const keep = new Set([...keepIds, ...warnedIds].map(id => String(id)));
  const next = {};

  for (const [id, at] of Object.entries(current)) {
    if (keep.has(id)) next[id] = at;
  }

  for (const id of warnedIds) next[String(id)] = now;

  // Writing on every sweep would mean a disk write every few minutes forever,
  // almost always with identical contents.
  const unchanged =
    Object.keys(next).length === Object.keys(current).length &&
    Object.entries(next).every(([id, at]) => current[id] === at);

  return unchanged ? current : saveWarned(next);
}

function clearStateCache() {
  cache = null;
}

module.exports = {
  STATE_PATH,
  clearStateCache,
  loadWarned,
  normalizeState,
  recordSweep,
  saveWarned,
  wasWarned
};
