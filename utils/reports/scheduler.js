// utils/reports/scheduler.js
// Deciding when a week has elapsed, and posting the report when it has.
//
// Times are UTC throughout. A timezone library would be a dependency this
// project does not take, and guessing the host's local zone is worse than being
// explicit — a box that moves from a US host to a European one would silently
// shift everyone's report. Every surface that shows a schedule says "UTC".
//
// The schedule is a weekly SLOT, not a timer. On each tick the scheduler asks
// "has the most recent slot passed without a post since?", so a bot that was
// offline at 18:00 Monday still reports when it comes back on Tuesday, and a
// bot that restarts five times an hour does not report five times.

const { loadConfig, saveConfig, channelFor, guildKey } = require('./config');
const { collectSnapshot } = require('./collect');
const { diffSnapshots } = require('./diff');
const { loadSnapshot, saveSnapshot } = require('./history');
const { buildOwnerIndex } = require('./links');
const { buildReportEmbed } = require('./render');
const { isGuildInScope } = require('../guildScope');
const { readConfig } = require('../../config');

const DAY_MS = 24 * 60 * 60 * 1000;

// Five minutes is far finer than a weekly schedule needs, and keeps the report
// close to the configured hour even after a restart.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** The most recent occurrence of the configured weekday and hour, in UTC. */
function lastSlotAt(config, from = Date.now()) {
  const slot = new Date(from);

  slot.setUTCHours(config.hour, 0, 0, 0);
  slot.setUTCDate(slot.getUTCDate() - ((slot.getUTCDay() - config.dayOfWeek + 7) % 7));

  // Stepping back to the weekday can still land later today than `from`.
  if (slot.getTime() > from) slot.setUTCDate(slot.getUTCDate() - 7);

  return slot.getTime();
}

/** When the next report is due. */
function nextSlotAt(config, from = Date.now()) {
  return lastSlotAt(config, from) + 7 * DAY_MS;
}

/**
 * Whether a report is owed.
 *
 * A null `lastPostedAt` counts as due, which only happens if the file was
 * hand-edited — `/report configure enabled` stamps it so that switching
 * reporting on waits for the next slot instead of firing immediately.
 */
function isDue(config, now = Date.now()) {
  if (!config.enabled) return false;
  if (config.guilds.length === 0) return false;
  if (!config.guilds.every(guild => channelFor(guild, config))) return false;

  return config.lastPostedAt === null || config.lastPostedAt < lastSlotAt(config, now);
}

/**
 * Builds one guild's report.
 *
 * `persist` is the difference between a preview and the real thing. Saving a
 * snapshot consumes the baseline the next report subtracts from, so `/report
 * now` must leave it alone — otherwise previewing on Sunday would make Monday's
 * report cover one day instead of seven.
 */
async function buildGuildReport(guild, { persist = false, now = Date.now(), onProgress } = {}) {
  const key = guildKey(guild);
  const { snapshot, warnings } = await collectSnapshot(guild, { capturedAt: now, onProgress });

  const previous = loadSnapshot(key);
  const diff = diffSnapshots(previous, snapshot);
  const embed = buildReportEmbed({ diff, owners: buildOwnerIndex(), warnings });

  if (persist) saveSnapshot(key, snapshot);

  return { key, guild, diff, embed, warnings, persisted: persist };
}

/**
 * Builds every tracked guild's report. One guild failing does not cost the
 * others theirs — a bad guild name or a Blizzard hiccup is reported in place.
 */
async function buildAllReports({ persist = false, now = Date.now(), config = loadConfig(), onProgress } = {}) {
  const reports = [];
  const failures = [];

  for (const guild of config.guilds) {
    try {
      reports.push(await buildGuildReport(guild, { persist, now, onProgress }));
    } catch (err) {
      failures.push({ guild, error: err });
      console.error(`❌ Weekly report failed for ${guild.name}-${guild.realm}:`, err.message);
    }
  }

  return { reports, failures };
}

/**
 * Sends the embeds, grouping guilds that share a channel into one message.
 *
 * The scope check matters: posting is not an interaction, so nothing else stops
 * a second instance sharing this token from posting the same report. A pinned
 * instance refuses to post anywhere but its own guild, which is the same
 * protection `GUILD_ID` gives the command handlers.
 */
async function publishReports(client, reports, { config = loadConfig(), guildId = readConfig().discord.guildId } = {}) {
  const byChannel = new Map();

  for (const report of reports) {
    const channelId = channelFor(report.guild, config);
    if (!channelId) continue;

    byChannel.set(channelId, [...(byChannel.get(channelId) ?? []), report.embed]);
  }

  const delivered = [];

  for (const [channelId, embeds] of byChannel) {
    try {
      const channel = await client.channels.fetch(channelId);

      if (!channel?.isTextBased?.()) {
        console.warn(`⚠️  Report channel ${channelId} is not a text channel; skipping.`);
        continue;
      }

      if (!isGuildInScope(channel.guildId, guildId)) {
        console.log(
          `↪️  Not posting the weekly report to ${channelId} — this instance is pinned to ${guildId}.`
        );
        continue;
      }

      // Discord accepts up to ten embeds per message, which is above the
      // tracked-guild ceiling, so one message per channel always fits.
      await channel.send({ embeds });
      delivered.push(channelId);
    } catch (err) {
      console.error(`❌ Could not post the weekly report to ${channelId}:`, err.message);
    }
  }

  return delivered;
}

/**
 * The whole scheduled job: build, post, and record that it happened.
 *
 * `lastPostedAt` is stamped even when nothing could be delivered, so a
 * misconfigured channel produces one failed attempt a week rather than one
 * every five minutes.
 */
async function runScheduledReports(client, { now = Date.now(), config = loadConfig() } = {}) {
  console.log(`📊 Building the weekly report for ${config.guilds.length} guild(s)…`);

  const { reports, failures } = await buildAllReports({ persist: true, now, config });
  const delivered = await publishReports(client, reports, { config });

  saveConfig({ lastPostedAt: now });

  console.log(
    `📊 Weekly report: ${reports.length} built, ${failures.length} failed, posted to ${delivered.length} channel(s).`
  );

  return { reports, failures, delivered };
}

/**
 * Starts the weekly check. Returns a stop function; the interval is unref'd so
 * it never holds the process open on shutdown.
 */
function startReportScheduler(client, { intervalMs = CHECK_INTERVAL_MS, now = () => Date.now() } = {}) {
  let running = false;

  const tick = async () => {
    // A large report can outlast the interval; overlapping runs would double-post.
    if (running) return;

    const config = loadConfig();
    if (!isDue(config, now())) return;

    running = true;
    try {
      await runScheduledReports(client, { now: now(), config });
    } catch (err) {
      console.error('❌ The weekly report scheduler failed:', err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}

module.exports = {
  CHECK_INTERVAL_MS,
  DAY_MS,
  buildAllReports,
  buildGuildReport,
  isDue,
  lastSlotAt,
  nextSlotAt,
  publishReports,
  runScheduledReports,
  startReportScheduler
};
