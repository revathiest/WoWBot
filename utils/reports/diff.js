// utils/reports/diff.js
// Turning two weekly snapshots into a list of things that changed.
//
// Pure: no discord.js, no fetch, no clock. Everything it needs arrives as an
// argument, which is what makes it testable with plain object literals — the
// same reason utils/spam/detector.js stays free of Discord types.
//
// The Blizzard API reports only CURRENT state — a season's total wins, a
// character's lifetime honorable kills, today's roster. None of it is per-week.
// So "gained 180 rating" and "killed 400 players this week" exist only because
// the previous week's snapshot was kept to subtract from. That is the entire
// reason this feature stores anything at all.

const { BRACKETS } = require('../blizzard/pvp');

/** Roster entries are matched between weeks by name, which is stable per realm. */
function memberKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

/**
 * Builds the object that gets written to disk.
 *
 * Deliberately small and flat — it is re-read a week later, so every field has
 * to survive a restart and a code change. Nothing derived is stored; that is
 * what `diffSnapshots` is for.
 */
function buildSnapshot({ guild, capturedAt, members = [] }) {
  const entries = {};

  for (const member of members) {
    const key = memberKey(member.name);
    if (!key) continue;

    entries[key] = {
      name: member.name,
      level: Number.isFinite(member.level) ? member.level : null,
      className: member.className ?? null,
      rank: Number.isFinite(member.rank) ? member.rank : null,
      kills: Number.isFinite(member.kills) ? member.kills : null,
      brackets: member.brackets ?? {}
    };
  }

  return { guild, capturedAt, members: entries };
}

/**
 * The level cap, derived from the roster rather than hardcoded.
 *
 * TBC is 70 today and will not stay that way — Anniversary realms advance
 * through expansions on Blizzard's schedule. Reading the highest level actually
 * present means the report follows the cap up on its own.
 */
function deriveMaxLevel(snapshot) {
  const levels = Object.values(snapshot?.members ?? {})
    .map(member => member.level)
    .filter(Number.isFinite);

  return levels.length > 0 ? Math.max(...levels) : null;
}

function summarize(member) {
  return { name: member.name, level: member.level, className: member.className };
}

/** Rank 0 is the guild master, so a SMALLER number is a more senior rank. */
function rankChanges(previous, current) {
  const promotions = [];
  const demotions = [];

  for (const [key, member] of Object.entries(current.members)) {
    const before = previous.members[key];
    if (!before || !Number.isFinite(before.rank) || !Number.isFinite(member.rank)) continue;
    if (before.rank === member.rank) continue;

    const change = { ...summarize(member), from: before.rank, to: member.rank };
    (member.rank < before.rank ? promotions : demotions).push(change);
  }

  return { promotions, demotions };
}

function levelChanges(previous, current, maxLevel) {
  const levelUps = [];

  for (const [key, member] of Object.entries(current.members)) {
    const before = previous.members[key];
    if (!before || !Number.isFinite(before.level) || !Number.isFinite(member.level)) continue;
    if (member.level <= before.level) continue;

    levelUps.push({
      ...summarize(member),
      from: before.level,
      to: member.level,
      // The headline event in any guild: somebody finished the grind.
      cappedOut: maxLevel !== null && member.level >= maxLevel && before.level < maxLevel
    });
  }

  // Highest level first, then the biggest climb, so new max-level characters
  // lead the section.
  return levelUps.sort((a, b) => b.to - a.to || b.to - b.from - (a.to - a.from));
}

function membershipChanges(previous, current) {
  const joined = Object.entries(current.members)
    .filter(([key]) => !previous.members[key])
    .map(([, member]) => summarize(member));

  const left = Object.entries(previous.members)
    .filter(([key]) => !current.members[key])
    .map(([, member]) => summarize(member));

  const byLevel = (a, b) => (b.level ?? 0) - (a.level ?? 0);

  return { joined: joined.sort(byLevel), left: left.sort(byLevel) };
}

/**
 * Per-bracket arena standing for guild members, best rating first.
 *
 * A member absent from last week's ladder is `isNew` rather than a huge gain —
 * reporting "+2100 rating" for someone who simply played their first rated game
 * would be nonsense.
 */
function arenaChanges(previous, current, brackets = BRACKETS) {
  return brackets
    .map(bracket => {
      const entries = [];

      for (const [key, member] of Object.entries(current.members)) {
        const standing = member.brackets?.[bracket];
        if (!standing || !Number.isFinite(standing.rating)) continue;

        const before = previous.members[key]?.brackets?.[bracket] ?? null;
        const hadRating = Boolean(before) && Number.isFinite(before.rating);

        entries.push({
          name: member.name,
          className: member.className,
          rating: standing.rating,
          rank: Number.isFinite(standing.rank) ? standing.rank : null,
          won: standing.won ?? 0,
          lost: standing.lost ?? 0,
          isNew: !hadRating,
          ratingChange: hadRating ? standing.rating - before.rating : null,
          // A falling rank NUMBER is an improvement, so invert it: positive
          // means "climbed the ladder", matching the rating delta's direction.
          rankChange:
            hadRating && Number.isFinite(before.rank) && Number.isFinite(standing.rank)
              ? before.rank - standing.rank
              : null,
          wonChange: hadRating ? (standing.won ?? 0) - (before.won ?? 0) : null,
          lostChange: hadRating ? (standing.lost ?? 0) - (before.lost ?? 0) : null
        });
      }

      return { bracket, entries: entries.sort((a, b) => b.rating - a.rating) };
    })
    .filter(bracket => bracket.entries.length > 0);
}

/**
 * Honorable kills gained since the last snapshot.
 *
 * Lifetime totals only go up, so a negative delta means the character was
 * renamed or transferred, or the endpoint returned nothing — never a real
 * result. Those are dropped rather than reported as a loss.
 */
function killChanges(previous, current) {
  const gains = [];

  for (const [key, member] of Object.entries(current.members)) {
    if (!Number.isFinite(member.kills)) continue;

    const before = previous.members[key];
    if (!before || !Number.isFinite(before.kills)) continue;

    const change = member.kills - before.kills;
    if (change <= 0) continue;

    gains.push({ name: member.name, className: member.className, total: member.kills, change });
  }

  return gains.sort((a, b) => b.change - a.change);
}

function totals(snapshot, maxLevel) {
  const members = Object.values(snapshot.members);

  return {
    members: members.length,
    atMaxLevel: maxLevel === null ? 0 : members.filter(member => member.level === maxLevel).length,
    ranked: members.filter(member => Object.keys(member.brackets ?? {}).length > 0).length,
    kills: members.reduce((sum, member) => sum + (member.kills ?? 0), 0)
  };
}

/**
 * The report model. `previous` may be null, which is a guild's first run: there
 * is nothing to subtract from, so only current standings are produced and
 * `isFirstRun` tells the renderer to say so rather than imply a quiet week.
 */
function diffSnapshots(previous, current, { brackets = BRACKETS } = {}) {
  const maxLevel = deriveMaxLevel(current);
  const base = previous ?? { members: {}, capturedAt: null };

  const { joined, left } = membershipChanges(base, current);
  const { promotions, demotions } = rankChanges(base, current);

  return {
    guild: current.guild,
    capturedAt: current.capturedAt,
    previousAt: base.capturedAt ?? null,
    isFirstRun: !previous,
    maxLevel,
    totals: totals(current, maxLevel),
    // The current roster, so the renderer can count who is reachable on
    // Discord. Derived from the snapshot just taken, never persisted.
    members: Object.values(current.members).map(summarize),
    // On a first run every member would read as a new recruit, which is
    // misleading, so membership changes are suppressed until there is a
    // baseline to compare against.
    joined: previous ? joined : [],
    left: previous ? left : [],
    levelUps: levelChanges(base, current, maxLevel),
    promotions,
    demotions,
    arena: arenaChanges(base, current, brackets),
    kills: killChanges(base, current)
  };
}

module.exports = {
  arenaChanges,
  buildSnapshot,
  deriveMaxLevel,
  diffSnapshots,
  killChanges,
  levelChanges,
  memberKey,
  membershipChanges,
  rankChanges,
  totals
};
