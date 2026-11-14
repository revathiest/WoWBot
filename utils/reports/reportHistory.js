// utils/reports/reportHistory.js
// A long-running log of what each report found, one entry per guild per time
// it actually posted.
//
// history.js (singular) deliberately keeps only the MOST RECENT snapshot —
// that is all a week-over-week diff needs. But that means nothing survives
// to answer "how has this guild trended over the last few months" — the
// previous week's numbers are gone the moment the next report overwrites
// them. This file is the append-only counterpart: not a full roster, just
// the handful of numbers `diffSnapshots` already produced, kept indefinitely
// (capped, so a guild tracked for years does not grow the file forever).

const fs = require('fs');
const path = require('path');

const { snapshotFileName } = require('./history');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const HISTORY_LOG_DIR = path.join(DATA_DIR, 'reports');

// Two years of weekly entries, comfortably more than a daily-cadence guild
// would ever want to scroll through, and small enough per entry (a dozen
// numbers) that even that ceiling stays a tiny file.
const MAX_ENTRIES = 104;

function historyLogPath(key) {
  return path.join(HISTORY_LOG_DIR, `history-${snapshotFileName(key)}`);
}

/** The stored entries, oldest first. Missing or corrupt reads as empty — nothing recorded yet, not a failure. */
function loadReportHistory(key) {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyLogPath(key), 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not read the report history for ${key}: ${err.message}`);
    }
    return [];
  }
}

/** Atomic, matching the other stores — a half-written log is worse than none. */
function saveReportHistory(key, entries) {
  fs.mkdirSync(HISTORY_LOG_DIR, { recursive: true });

  const target = historyLogPath(key);
  const tempPath = `${target}.tmp`;

  fs.writeFileSync(tempPath, `${JSON.stringify({ entries })}\n`, 'utf8');
  fs.renameSync(tempPath, target);

  return entries;
}

/**
 * Turns one report's diff into the compact record that gets kept forever.
 * Names are deliberately left out — who joined or left is already in the
 * Discord report and the Excel export's Changes sheet for the current week;
 * this log exists to answer "how is the guild trending", which is counts, not
 * names.
 */
function summarizeForHistory(diff) {
  return {
    capturedAt: diff.capturedAt,
    isFirstRun: diff.isFirstRun,
    members: diff.totals.members,
    atMaxLevel: diff.totals.atMaxLevel,
    joined: diff.joined.length,
    left: diff.left.length,
    levelUps: diff.levelUps.length,
    promotions: diff.promotions.length,
    demotions: diff.demotions.length,
    killsGained: diff.kills.reduce((sum, entry) => sum + entry.change, 0)
  };
}

/**
 * Appends one entry, keeping only the most recent `MAX_ENTRIES`.
 *
 * Call this only when a report persists — the same condition that updates
 * history.js's snapshot and killHistory.js's kill log, so all three stay in
 * step with what actually posted.
 */
function appendReportHistoryEntry(key, diff) {
  const entries = [...loadReportHistory(key), summarizeForHistory(diff)]
    .sort((a, b) => a.capturedAt - b.capturedAt)
    .slice(-MAX_ENTRIES);

  return saveReportHistory(key, entries);
}

/** Used when a guild stops being tracked, so its history does not linger. */
function deleteReportHistory(key) {
  try {
    fs.unlinkSync(historyLogPath(key));
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not delete the report history for ${key}: ${err.message}`);
    }
    return false;
  }
}

module.exports = {
  HISTORY_LOG_DIR,
  MAX_ENTRIES,
  appendReportHistoryEntry,
  deleteReportHistory,
  historyLogPath,
  loadReportHistory,
  saveReportHistory,
  summarizeForHistory
};
