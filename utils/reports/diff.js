// utils/reports/diff.js
// Turning two weekly snapshots into a list of things that changed.
//
// Pure: no discord.js, no fetch, no clock. Everything it needs arrives as an
// argument, which is what makes it testable with plain object literals — the
// same reason utils/spam/detector.js stays free of Discord types.
//
// The Blizzard API reports only CURRENT state — a character's lifetime
// honorable kills, today's roster. None of it is per-week. So "killed 400
// players this week" exists only because the previous week's snapshot was
// kept to subtract from. That is the entire reason this feature stores
// anything at all.

/**
 * Roster entries are matched between weeks by name AND surname: a roster can
 * hold two characters with the same first name, and without the surname they
 * would collapse into one entry, with kills attributed to whichever was read
 * last.
 */
function memberKey(name, surname) {
  const first = String(name ?? '').trim().toLowerCase();
  const last = String(surname ?? '').trim().toLowerCase();

  return last ? `${first}-${last}` : first;
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
    const key = memberKey(member.name, member.surname);
    if (!key) continue;

    entries[key] = {
      name: member.name,
      surname: member.surname ?? null,
      level: Number.isFinite(member.level) ? member.level : null,
      className: member.className ?? null,
      rank: Number.isFinite(member.rank) ? member.rank : null,
      kills: Number.isFinite(member.kills) ? member.kills : null
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
  return {
    name: member.name,
    surname: member.surname ?? null,
    level: member.level,
    className: member.className
  };
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

    gains.push({
      name: member.name,
      surname: member.surname ?? null,
      className: member.className,
      total: member.kills,
      change
    });
  }

  return gains.sort((a, b) => b.change - a.change);
}

function totals(snapshot, maxLevel) {
  const members = Object.values(snapshot.members);

  return {
    members: members.length,
    atMaxLevel: maxLevel === null ? 0 : members.filter(member => member.level === maxLevel).length,
    kills: members.reduce((sum, member) => sum + (member.kills ?? 0), 0)
  };
}

/**
 * The report model. `previous` may be null, which is a guild's first run: there
 * is nothing to subtract from, so only current standings are produced and
 * `isFirstRun` tells the renderer to say so rather than imply a quiet week.
 */
function diffSnapshots(previous, current) {
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
    kills: killChanges(base, current)
  };
}

module.exports = {
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
