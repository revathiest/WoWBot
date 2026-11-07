// utils/reports/killTally.js
// Three honorable-kill figures per member — lifetime, the last 7 days, and
// today — computed from the rolling history in killHistory.js plus the
// names, classes, and current totals already held in the regular roster
// snapshot.
//
// Pure: no discord.js, no fetch, no clock reads of its own. `priorEntries`
// must be the guild's kill history from BEFORE the current capture, so the
// same function serves two callers that sit on either side of that moment:
// the scheduler, computing today's tally right before appending today's
// entry, and the report's button, re-deriving the same tally afterwards by
// dropping the now-appended last entry and treating the stored snapshot as
// "current" again.

const { DAY_MS, entryAtOrBefore } = require('./killHistory');

/**
 * Null rather than a number when there is nothing to subtract from.
 *
 * Lifetime kills only ever go up (see diff.js's killChanges) — a drop means a
 * rename, a transfer, or a bad read, never a real loss, so it is dropped
 * rather than shown as a negative gain.
 */
function diffOrNull(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;

  const change = current - previous;
  return change >= 0 ? change : null;
}

/**
 * @param {object[]} priorEntries  This guild's kill history, from before the
 *   current capture — i.e. whatever `loadKillHistory` returned before
 *   `appendKillEntry` was called for `capturedAt`.
 * @param {object} members  The current snapshot's members, keyed by
 *   `memberKey` (diff.js) — the same keying `priorEntries[].kills` uses.
 * @param {number} capturedAt  When the current totals were captured.
 * @returns {object[]} One entry per member with kill data, sorted by today's
 *   gain (unknown last), then lifetime total.
 */
function buildKillTally(priorEntries, members, capturedAt) {
  const sorted = [...(priorEntries ?? [])].sort((a, b) => a.capturedAt - b.capturedAt);
  const yesterday = sorted.at(-1) ?? null;
  const weekAgo = entryAtOrBefore(sorted, capturedAt - 7 * DAY_MS) ?? sorted[0] ?? null;

  const tally = [];

  for (const [key, member] of Object.entries(members ?? {})) {
    if (!Number.isFinite(member.kills)) continue;

    tally.push({
      name: member.name,
      surname: member.surname ?? null,
      className: member.className ?? null,
      lifetime: member.kills,
      today: yesterday ? diffOrNull(member.kills, yesterday.kills[key]) : null,
      last7: weekAgo ? diffOrNull(member.kills, weekAgo.kills[key]) : null
    });
  }

  return tally.sort(
    (a, b) => (b.today ?? -Infinity) - (a.today ?? -Infinity) || b.lifetime - a.lifetime
  );
}

module.exports = { buildKillTally, diffOrNull };
