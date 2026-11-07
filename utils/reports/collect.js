// utils/reports/collect.js
// Gathers everything one weekly report needs from the Blizzard API and folds it
// into a snapshot.
//
// Cost, for a 240-member guild: one roster call, one class index (cached for a
// day), and one honorable-kill call per member. The per-member calls dominate,
// so they run concurrently and tolerate individual failures — one character
// with a broken profile must not cost the guild its report.

const { getPlayableClassIndex } = require('../blizzard/gameData');
const { getGuildRoster, slugifyGuild } = require('../blizzard/guild');
const { getCharacterPvpSummary } = require('../blizzard/profile');
const { characterSlug } = require('../wow');
const { buildSnapshot, memberKey } = require('./diff');

// Blizzard allows 100 requests a second; this stays far under it while still
// finishing a large roster in well under a minute.
const KILL_CONCURRENCY = 8;

// A ceiling so a pathologically large guild cannot turn one report into
// thousands of calls. Members are looked up highest level first, so a guild
// over the limit still gets its raiders counted.
const MAX_KILL_LOOKUPS = 500;

// Class names change almost never.
const CLASS_INDEX_TTL_MS = 24 * 60 * 60 * 1000;

const classIndexCache = new Map();

function clearClassIndexCache() {
  classIndexCache.clear();
}

/**
 * Class id -> name for a region.
 *
 * Guild rosters carry `playable_class.id` but no name, so printing a member's
 * class means resolving ids separately. Failure is non-fatal: the report
 * simply omits class names.
 */
async function getClassNames({ region }) {
  const cached = classIndexCache.get(region);

  if (cached && cached.expiresAt > Date.now()) return cached.names;

  const names = new Map();

  try {
    const index = await getPlayableClassIndex({ region });
    for (const playableClass of index?.classes ?? []) {
      if (Number.isFinite(playableClass.id) && playableClass.name) {
        names.set(playableClass.id, playableClass.name);
      }
    }
  } catch (err) {
    console.warn(`⚠️  Could not read the class index for ${region}: ${err.message}`);
  }

  classIndexCache.set(region, { expiresAt: Date.now() + CLASS_INDEX_TTL_MS, names });
  return names;
}

/** Runs an async mapper over a list, `limit` at a time, preserving order. */
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Lifetime honorable kills per member.
 *
 * `pvp-summary` 200s for Classic Forever and returns `honorable_kills` — the
 * vanilla honour system, not arena, which this flavour has none of.
 *
 * A 404 here is NORMAL and is counted separately from a failure: characters
 * below level 10, and those not yet logged out once, have no published
 * profile. Reporting those as errors would put a warning on every single
 * report and teach people to ignore it. Only a non-404 — a rate limit, a 5xx,
 * a timeout — means something actually went wrong.
 */
async function collectKills(members, { region, concurrency = KILL_CONCURRENCY, onProgress }) {
  const targets = [...members]
    .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
    .slice(0, MAX_KILL_LOOKUPS);

  const kills = new Map();
  let failures = 0;
  let missing = 0;
  let done = 0;

  await mapWithConcurrency(targets, concurrency, async member => {
    const slug = characterSlug(member.name, member.surname);

    // A member with no surname cannot be addressed at all. Count it with the
    // misses rather than firing a request that must 404.
    if (!slug) {
      missing += 1;
      done += 1;
      return;
    }

    try {
      const summary = await getCharacterPvpSummary(slug, { region });

      if (Number.isFinite(summary?.honorable_kills)) {
        kills.set(memberKey(member.name, member.surname), summary.honorable_kills);
      }
    } catch (err) {
      if (err?.status === 404) missing += 1;
      else failures += 1;
    } finally {
      done += 1;
      if (onProgress && done % 25 === 0) onProgress({ done, total: targets.length });
    }
  });

  return {
    kills,
    failures,
    missing,
    attempted: targets.length,
    capped: members.length > MAX_KILL_LOOKUPS
  };
}

/** Roster entries in the shape the snapshot wants, minus kills. */
function readRoster(roster, classNames) {
  return (roster?.members ?? [])
    .map(member => ({
      name: member.character?.name,
      // The other half of the name, and the only thing that tells two
      // same-named roster members apart.
      surname: member.character?.surname ?? null,
      level: member.character?.level,
      rank: member.rank,
      className:
        member.character?.playable_class?.name ??
        classNames.get(member.character?.playable_class?.id) ??
        null
    }))
    .filter(member => Boolean(member.name));
}

/**
 * Builds one guild's snapshot.
 *
 * @returns {Promise<{snapshot: object, warnings: string[], guildSlug: string}>}
 */
async function collectSnapshot(guild, { capturedAt = Date.now(), concurrency, onProgress, includeKills = true } = {}) {
  const { region } = guild;
  const guildSlug = slugifyGuild(guild.name);
  const warnings = [];

  let roster;
  try {
    roster = await getGuildRoster(guildSlug, { region });
  } catch (err) {
    // There is no guild index to suggest names from, so the best help available
    // is naming the slug that was tried. The command turns this into a
    // message; see the note in utils/blizzard/guild.js.
    err.guildSlug = guildSlug;
    throw err;
  }

  const classNames = await getClassNames({ region });
  const members = readRoster(roster, classNames);

  let kills = new Map();
  if (includeKills) {
    const collected = await collectKills(members, { region, concurrency, onProgress });

    kills = collected.kills;

    if (collected.capped) {
      warnings.push(`Honorable kills cover the top ${MAX_KILL_LOOKUPS} members by level.`);
    }
    if (collected.failures > 0) {
      warnings.push(
        `${collected.failures} of ${collected.attempted} honorable-kill lookups errored and were skipped.`
      );
    }
  }

  const snapshot = buildSnapshot({
    guild: {
      name: roster?.guild?.name ?? guild.name,
      faction: roster?.guild?.faction?.name ?? null,
      region
    },
    capturedAt,
    members: members.map(member => ({
      ...member,
      kills: kills.get(memberKey(member.name, member.surname)) ?? null
    }))
  });

  return { snapshot, warnings, guildSlug };
}

module.exports = {
  CLASS_INDEX_TTL_MS,
  KILL_CONCURRENCY,
  MAX_KILL_LOOKUPS,
  clearClassIndexCache,
  collectKills,
  collectSnapshot,
  getClassNames,
  mapWithConcurrency,
  readRoster
};
