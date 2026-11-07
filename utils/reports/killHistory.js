// utils/reports/killHistory.js
// A short rolling history of daily honorable-kill totals, per tracked guild.
//
// history.js keeps exactly ONE previous snapshot — enough for "what changed
// since the last report", but not enough to answer "how many kills in the
// last 7 days", which needs a point from roughly a week back. This keeps a
// small window of `{ capturedAt, kills }` entries just for that; everything
// else about a member (name, class, level) still comes from the regular
// snapshot, so this file stays tiny even for a 250-member guild — it is a map
// of character key to a single number, once a day.

const fs = require('fs');
const path = require('path');

const { snapshotFileName } = require('./history');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const KILL_HISTORY_DIR = path.join(DATA_DIR, 'reports');

// One entry a day is the design point. A few spares absorb a missed day
// (downtime, a failed collect) without losing the 7-day baseline entirely.
const MAX_ENTRIES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

function killHistoryPath(key) {
  return path.join(KILL_HISTORY_DIR, `kills-${snapshotFileName(key)}`);
}

/** The stored entries, oldest first. Missing or corrupt reads as empty — a first run, not a failure. */
function loadKillHistory(key) {
  try {
    const parsed = JSON.parse(fs.readFileSync(killHistoryPath(key), 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not read the kill history for ${key}: ${err.message}`);
    }
    return [];
  }
}

/** Atomic, matching the other stores — a half-written history is worse than none. */
function saveKillHistory(key, entries) {
  fs.mkdirSync(KILL_HISTORY_DIR, { recursive: true });

  const target = killHistoryPath(key);
  const tempPath = `${target}.tmp`;

  fs.writeFileSync(tempPath, `${JSON.stringify({ entries })}\n`, 'utf8');
  fs.renameSync(tempPath, target);

  return entries;
}

/**
 * Appends today's totals, keeping only the most recent `MAX_ENTRIES`.
 *
 * `kills` is a plain object of character key -> lifetime honorable kills,
 * keyed the same way `memberKey` in diff.js keys a snapshot's members.
 */
function appendKillEntry(key, { capturedAt, kills }) {
  const entries = [...loadKillHistory(key), { capturedAt, kills }]
    .sort((a, b) => a.capturedAt - b.capturedAt)
    .slice(-MAX_ENTRIES);

  return saveKillHistory(key, entries);
}

/** Used when a guild stops being tracked, so its history does not linger. */
function deleteKillHistory(key) {
  try {
    fs.unlinkSync(killHistoryPath(key));
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not delete the kill history for ${key}: ${err.message}`);
    }
    return false;
  }
}

/**
 * The most recent entry at or before `timestamp` — the "N days ago" baseline.
 * Assumes `entries` is sorted oldest first, which is what `appendKillEntry`
 * guarantees.
 */
function entryAtOrBefore(entries, timestamp) {
  let found = null;

  for (const entry of entries) {
    if (entry.capturedAt <= timestamp) found = entry;
  }

  return found;
}

module.exports = {
  DAY_MS,
  KILL_HISTORY_DIR,
  MAX_ENTRIES,
  appendKillEntry,
  deleteKillHistory,
  entryAtOrBefore,
  killHistoryPath,
  loadKillHistory,
  saveKillHistory
};
