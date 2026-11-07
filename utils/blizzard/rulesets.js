// utils/blizzard/rulesets.js
// Classic Forever's replacement for realms.
//
// Forever publishes no realms at all: `/data/wow/realm/index` 404s and
// `/data/wow/search/realm` answers 200 with `pageCount: 0`, so the realm
// collection is live and permanently empty. What it has instead is RULESETS —
// four of them, measured 2026-11-06 in both us and eu:
//
//   1  PvP          2  Normal          3  Roleplay          15 Roleplay PvP
//
// A ruleset is the nearest thing to a realm: it has a name, an up/down status,
// and its own auction houses. It is NOT part of a character's address, though —
// characters are addressed by `{name}-{surname}` and carry a `ruleset` reference
// as a property. So nothing here is needed to look a character up; this exists
// so /realm and /realms have something true to report.
//
// Deliberately shaped like `realms.js` (cache, find, search, resolve) so the
// commands can treat the two interchangeably.

const { getRuleset, getRulesetIndex } = require('./gameData');
const { realmMatchKey, slugifyRealm } = require('../wow');
const { DEFAULT_GAME, DEFAULT_REGION } = require('../../config');

// Rulesets change about as often as realms do, which is to say almost never.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const cache = new Map(); // `${region}:${game}` -> { expiresAt, rulesets }

function cacheKey(region, game) {
  return `${region}:${game}`;
}

function clearRulesetCache() {
  cache.clear();
}

/** Ruleset index entries are `{ id, key: { href } }` and nothing more. */
function idsFromIndex(index) {
  return (index?.rulesets ?? [])
    .map(entry => entry?.id)
    .filter(id => Number.isFinite(id));
}

/**
 * Every ruleset for a region+game as `{ id, name, slug, status, auctionsHref }`,
 * sorted by name. Cached for six hours.
 *
 * Costs one request for the index plus one per ruleset, because the index omits
 * names and statuses. Four rulesets makes that five requests, which is why the
 * assembled list is what gets cached.
 *
 * A ruleset whose document cannot be read is dropped rather than failing the
 * whole list: a partial list still answers "which rulesets are there".
 */
async function getRulesets(options = {}) {
  const region = options.region ?? DEFAULT_REGION;
  const game = options.game ?? DEFAULT_GAME;
  const key = cacheKey(region, game);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.rulesets;

  const index = await getRulesetIndex({ ...options, region, game });

  const documents = await Promise.all(
    idsFromIndex(index).map(id =>
      getRuleset(id, { ...options, region, game }).catch(err => {
        console.warn(`Could not read ruleset ${id}: ${err.message}`);
        return null;
      })
    )
  );

  const rulesets = documents
    .filter(Boolean)
    .map(doc => ({
      id: doc.id,
      name: doc.name,
      slug: slugifyRealm(doc.name),
      status: doc.status?.type ?? null,
      statusLabel: doc.status?.name ?? null,
      auctionsHref: doc.auctions?.href ?? null
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, rulesets });

  return rulesets;
}

/** Exact match on name, slug, or id, ignoring case and punctuation. */
function findRuleset(rulesets, query) {
  const raw = String(query ?? '').trim();
  if (!raw) return null;

  if (/^[0-9]+$/.test(raw)) {
    const byId = rulesets.find(ruleset => ruleset.id === Number(raw));
    if (byId) return byId;
  }

  const key = realmMatchKey(raw);
  if (!key) return null;

  return (
    rulesets.find(
      ruleset => realmMatchKey(ruleset.name) === key || realmMatchKey(ruleset.slug) === key
    ) ?? null
  );
}

/** Substring match, for listings and "did you mean" suggestions. */
function searchRulesets(rulesets, query) {
  const key = realmMatchKey(query);
  if (!key) return rulesets;

  return rulesets.filter(
    ruleset =>
      realmMatchKey(ruleset.name).includes(key) || realmMatchKey(ruleset.slug).includes(key)
  );
}

/**
 * Resolves user input to a real ruleset.
 *
 * Unlike `resolveRealm` there is NO derived-slug fallback. Realm slugs can be
 * guessed from a name because the path contains the slug; a ruleset is addressed
 * by numeric id, which cannot be derived from what someone typed. So a failure
 * here returns null and the caller reports it, rather than guessing an id and
 * showing another ruleset's data.
 *
 * @returns {Promise<{id: number, name: string, slug: string, status: string|null}|null>}
 */
async function resolveRuleset(query, options = {}) {
  try {
    return findRuleset(await getRulesets(options), query);
  } catch (err) {
    console.warn(`Could not read the ruleset index: ${err.message}`);
    return null;
  }
}

module.exports = {
  CACHE_TTL_MS,
  clearRulesetCache,
  findRuleset,
  getRulesets,
  idsFromIndex,
  resolveRuleset,
  searchRulesets
};
