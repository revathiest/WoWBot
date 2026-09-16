// utils/reports/history.js
// Last week's snapshot for each tracked guild, one small JSON file apiece.
//
// One file per guild rather than one combined file: a 240-member roster with
// arena standings is a few hundred kilobytes, two guilds double it, and a
// combined write would rewrite every guild's history to record one. Separate
// files also mean a corrupt snapshot costs one guild a week of deltas instead
// of all of them.
//
// Only the most recent snapshot is kept. Nothing here is an archive — the file
// exists solely so next week's report has something to subtract from.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SNAPSHOT_DIR = path.join(DATA_DIR, 'reports');

/**
 * Guild keys are already folded to `region:game:realm:guild` with accents and
 * punctuation stripped, but they name a file, so anything left that could
 * escape the directory is replaced rather than trusted.
 */
function snapshotFileName(key) {
  return `${String(key ?? '').replace(/[^a-z0-9:-]/gi, '_').replace(/:/g, '-')}.json`;
}

function snapshotPath(key) {
  return path.join(SNAPSHOT_DIR, snapshotFileName(key));
}

/** The previous snapshot, or null when this guild has never been captured. */
function loadSnapshot(key) {
  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath(key), 'utf8'));
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not read the snapshot for ${key}: ${err.message}`);
    }
    // A missing or unreadable snapshot is not fatal: the report degrades to a
    // first run, which states plainly that it has nothing to compare against.
    return null;
  }
}

/** Atomic, matching the other stores — a half-written snapshot is worse than none. */
function saveSnapshot(key, snapshot) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const target = snapshotPath(key);
  const tempPath = `${target}.tmp`;

  fs.writeFileSync(tempPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
  fs.renameSync(tempPath, target);

  return snapshot;
}

/** Used when a guild stops being tracked, so its history does not linger. */
function deleteSnapshot(key) {
  try {
    fs.unlinkSync(snapshotPath(key));
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not delete the snapshot for ${key}: ${err.message}`);
    }
    return false;
  }
}

module.exports = {
  SNAPSHOT_DIR,
  deleteSnapshot,
  loadSnapshot,
  saveSnapshot,
  snapshotFileName,
  snapshotPath
};
