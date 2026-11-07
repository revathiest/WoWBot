// utils/namespaceWatch/watcher.js
// The periodic poll, and the decision about whether a result is news.
//
// Unlike the report scheduler this is a plain interval rather than a slot: a
// poll has no "correct" time to happen, so there is nothing to catch up on
// after a restart. What a restart must NOT do is re-announce, and that is the
// store's job rather than the schedule's.

const { readConfig } = require('../../config');
const { CHECKS, WATCHED_GAME, isAnnounceable } = require('./checks');
const { runChecks, readPatch } = require('./probe');
const { announce, buildAnnouncement } = require('./announce');
const store = require('./store');
const { record } = require('../audit/log');

/**
 * Compares a poll against what was last recorded.
 *
 * The first poll of a fresh deployment establishes a baseline SILENTLY. Without
 * that, standing up the bot would immediately announce "static is live" as
 * though it had just happened, which is both wrong and the kind of noise that
 * gets a channel muted.
 */
function diffResults(results, { store: previous = store.load() } = {}) {
  const baseline = previous.lastCheckedAt === null;
  const changes = [];

  for (const result of results) {
    const before = previous.endpoints[result.key]?.state ?? null;

    if (baseline || before === null) continue;
    if (!isAnnounceable(before, result.state)) continue;

    changes.push({ key: result.key, from: before, to: result.state });
  }

  return { changes, baseline };
}

/**
 * One poll: probe, compare, announce, persist.
 *
 * Persisting happens even when nothing is announced, because `lastCheckedAt` is
 * what turns the next poll from a baseline into a comparison.
 */
async function runOnce(client, { config = readConfig(), now = Date.now() } = {}) {
  const region = config.blizzard.region;
  const previous = store.load();

  const { results } = await runChecks({
    region,
    checks: CHECKS,
    character: config.namespaceWatch.character,
    now
  });
  const metadata = await readPatch({ region });
  const patch = metadata?.patch ?? null;

  const { changes, baseline } = await Promise.resolve(diffResults(results, { store: previous }));

  const patchChanged = Boolean(patch) && previous.patch !== null && previous.patch !== patch;

  let posted = { posted: false, reason: 'no change' };

  if (!baseline && (changes.length > 0 || patchChanged)) {
    const embed = buildAnnouncement({
      changes,
      patch,
      patchChanged,
      region,
      regionName: metadata?.regionName ?? null
    });

    posted = await announce(client, embed, {
      channel: config.namespaceWatch.channel,
      guildId: config.discord.guildId
    });

    record(client, {
      kind: 'info',
      action: `detected a change in the \`${WATCHED_GAME}\` namespace`,
      detail: changes.map(change => `${change.key}: ${change.from} → ${change.to}`).join(', ')
        || `patch ${patch}`,
      automatic: true,
      ok: posted.posted
    });
  }

  store.recordResults(results, { now, patch });

  const summary = results.reduce((counts, result) => {
    counts[result.state] = (counts[result.state] ?? 0) + 1;
    return counts;
  }, {});

  if (baseline) {
    console.log(
      `🔭 Namespace watch: baseline recorded for \`${WATCHED_GAME}\` — ` +
        `${summary.available ?? 0} live, ${summary.pending ?? 0} pending. No announcement on a first run.`
    );
  } else if (changes.length > 0 || patchChanged) {
    console.log(
      `🔭 Namespace watch: ${changes.length} change(s) in \`${WATCHED_GAME}\`` +
        (posted.posted ? ' — announced.' : ` — NOT announced (${posted.reason}).`)
    );
  }

  return { results, changes, baseline, patch, patchChanged, posted, summary };
}

/**
 * Starts the poll. Returns a stop function; the interval is unref'd so it never
 * holds the process open on shutdown, matching `startReportScheduler`.
 *
 * The first poll runs on the first tick rather than immediately, so startup is
 * not slowed by nine sequential Blizzard requests.
 */
function startNamespaceWatcher(client, { config = readConfig(), now = () => Date.now() } = {}) {
  if (!config.namespaceWatch.enabled) {
    console.log('   Namespace watch: ⚪ off — NAMESPACE_WATCH=true to follow the `forever` namespace');
    return () => {};
  }

  const hours = (config.namespaceWatch.intervalMs / (60 * 60 * 1000)).toFixed(1);
  console.log(
    `   Namespace watch: 🔭 \`${WATCHED_GAME}\` every ${hours}h → #${config.namespaceWatch.channel}`
  );

  let running = false;

  const tick = async () => {
    // Nine sequential requests with retries can outlast a short interval.
    if (running) return;

    running = true;
    try {
      await runOnce(client, { config, now: now() });
    } catch (err) {
      // A watcher is a convenience; it must never take the bot down with it.
      console.error('❌ The namespace watcher failed:', err.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, config.namespaceWatch.intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}

module.exports = { diffResults, runOnce, startNamespaceWatcher };
