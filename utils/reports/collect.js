// utils/reports/collect.js
// Gathers everything one weekly report needs from the Blizzard API and folds it
// into a snapshot.
//
// Cost, for a 240-member guild: one roster call, one class index (cached for a
// day), three leaderboard calls (cached ten minutes by pvp.js), and one
// honorable-kill call per member. The per-member calls dominate, so they run
// concurrently and tolerate individual failures — one character with a broken
// profile must not cost the guild its report.

const { getPlayableClassIndex } = require('../blizzard/gameData');
const { getGuildRoster, slugifyGuild } = require('../blizzard/guild');
const { getCharacterPvpSummary, getCurrentSeasonId, getLeaderboard, BRACKETS } = require('../blizzard/pvp');
const { resolveRealm } = require('../blizzard/realms');
const { encodeCharacterName } = require('../wow');
const { buildSnapshot, memberKey } = require('./diff');

// Blizzard allows 100 requests a second; this stays far under it while still
// finishing a large roster in well under a minute.
const KILL_CONCURRENCY = 8;

// A ceiling so a pathologically large guild cannot turn one report into
// thousands of calls. Members are looked up highest level first, so a guild
// over the limit still gets its raiders counted.
const MAX_KILL_LOOKUPS = 500;

// Class names change only when Blizzard ships an expansion.
const CLASS_INDEX_TTL_MS = 24 * 60 * 60 * 1000;

const classIndexCache = new Map();

function clearClassIndexCache() {
  classIndexCache.clear();
}

/**
 * Class id -> name for a game version.
 *
 * Guild rosters on Anniversary carry `playable_class.id` but no name, so
 * printing a member's class means resolving ids separately. Failure is
 * non-fatal: the report simply omits class names.
 */
async function getClassNames({ region, game }) {
  const key = `${region}:${game}`;
  const cached = classIndexCache.get(key);

  if (cached && cached.expiresAt > Date.now()) return cached.names;

  const names = new Map();

  try {
    const index = await getPlayableClassIndex({ region, game });
    for (const playableClass of index?.classes ?? []) {
      if (Number.isFinite(playableClass.id) && playableClass.name) {
        names.set(playableClass.id, playableClass.name);
      }
    }
  } catch (err) {
    console.warn(`⚠️  Could not read the class index for ${key}: ${err.message}`);
  }

  classIndexCache.set(key, { expiresAt: Date.now() + CLASS_INDEX_TTL_MS, names });
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
 * Every guild member's arena standing, keyed by member name.
 *
 * A ladder is scanned once per bracket rather than queried per character: one
 * bracket is around 5,000 entries and there is no per-character ladder lookup,
 * so three passes over three cached lists beats hundreds of requests.
 */
async function collectArena({ region, game, realmSlug, brackets = BRACKETS }) {
  const seasonId = await getCurrentSeasonId({ region, game });
  if (seasonId === null) return { seasonId: null, standings: new Map() };

  const standings = new Map();

  for (const bracket of brackets) {
    let entries;

    try {
      entries = await getLeaderboard(seasonId, bracket, { region, game });
    } catch (err) {
      console.warn(`⚠️  Could not read the ${bracket} ladder: ${err.message}`);
      continue;
    }

    for (const entry of entries) {
      if (entry.character?.realm?.slug !== realmSlug) continue;

      const key = memberKey(entry.character?.name);
      if (!key) continue;

      const stats = entry.season_match_statistics ?? {};
      const forMember = standings.get(key) ?? {};

      forMember[bracket] = {
        rating: entry.rating,
        rank: entry.rank,
        won: stats.won ?? 0,
        lost: stats.lost ?? 0
      };

      standings.set(key, forMember);
    }
  }

  return { seasonId, standings };
}

/**
 * Lifetime honorable kills per member.
 *
 * Verified present on TBC Anniversary — `pvp-summary` returns `honorable_kills`
 * there, which is what makes a weekly PvP section possible at all.
 *
 * A 404 here is NORMAL and is counted separately from a failure. Measured
 * against a real 240-member guild, 23 members had no PvP summary: bank alts
 * parked at level 1, plus a few characters whose profile Blizzard has not
 * published. Reporting those as errors would put a warning on every single
 * report and teach people to ignore it. Only a non-404 — a rate limit, a 5xx,
 * a timeout — means something actually went wrong.
 */
async function collectKills(members, { region, game, realmSlug, concurrency = KILL_CONCURRENCY, onProgress }) {
  const targets = [...members]
    .sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
    .slice(0, MAX_KILL_LOOKUPS);

  const kills = new Map();
  let failures = 0;
  let missing = 0;
  let done = 0;

  await mapWithConcurrency(targets, concurrency, async member => {
    try {
      const summary = await getCharacterPvpSummary(realmSlug, encodeCharacterName(member.name), {
        region,
        game
      });

      if (Number.isFinite(summary?.honorable_kills)) {
        kills.set(memberKey(member.name), summary.honorable_kills);
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

/** Roster entries in the shape the snapshot wants, minus kills and arena. */
function readRoster(roster, classNames) {
  return (roster?.members ?? [])
    .map(member => ({
      name: member.character?.name,
      level: member.character?.level,
      rank: member.rank,
      // Roster entries carry an id and, on retail only, a name.
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
 * @returns {Promise<{snapshot: object, warnings: string[], realmSlug: string, guildSlug: string}>}
 */
async function collectSnapshot(guild, { capturedAt = Date.now(), concurrency, onProgress, includeKills = true } = {}) {
  const { region, game } = guild;
  const realm = await resolveRealm(guild.realm, { region, game });
  const guildSlug = slugifyGuild(guild.name);
  const warnings = [];

  let roster;
  try {
    roster = await getGuildRoster(realm.slug, guildSlug, { region, game });
  } catch (err) {
    // There is no guild index to suggest names from, so the best help available
    // is naming the slugs that were tried. The command turns these into a
    // message; see the note in utils/blizzard/guild.js.
    err.realmSlug = realm.slug;
    err.guildSlug = guildSlug;
    throw err;
  }

  const classNames = await getClassNames({ region, game });
  const members = readRoster(roster, classNames);

  const { seasonId, standings } = await collectArena({ region, game, realmSlug: realm.slug });
  if (seasonId === null) warnings.push('No PvP season is published for this game version, so there is no arena section.');

  let kills = new Map();
  if (includeKills) {
    const collected = await collectKills(members, {
      region,
      game,
      realmSlug: realm.slug,
      concurrency,
      onProgress
    });

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
      realm: roster?.guild?.realm?.name ?? realm.name,
      realmSlug: realm.slug,
      faction: roster?.guild?.faction?.name ?? null,
      region,
      game,
      seasonId
    },
    capturedAt,
    members: members.map(member => ({
      ...member,
      kills: kills.get(memberKey(member.name)) ?? null,
      brackets: standings.get(memberKey(member.name)) ?? {}
    }))
  });

  return { snapshot, warnings, realmSlug: realm.slug, guildSlug };
}

module.exports = {
  CLASS_INDEX_TTL_MS,
  KILL_CONCURRENCY,
  MAX_KILL_LOOKUPS,
  clearClassIndexCache,
  collectArena,
  collectKills,
  collectSnapshot,
  getClassNames,
  mapWithConcurrency,
  readRoster
};
