// utils/blizzard/realms.js
// A cached realm index per region+game, used to resolve what the user typed into
// the exact slug Blizzard expects. Deriving slugs by hand is error-prone (hyphens
// are deleted, accents are kept), so prefer a real slug from the index.

const { getRealmIndex } = require('./gameData');
const { realmMatchKey, slugifyRealm } = require('../wow');
const { DEFAULT_GAME, DEFAULT_REGION } = require('../../config');

// The realm list changes only when Blizzard adds or renames realms.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Internal/test realms Blizzard leaves in the index. They are not playable and
// only add noise to listings: "US1A2-INST", "US2 CWOW CSI 80", "zzz_RDB EU",
// and "PROGWOW US1 Web" on the Anniversary namespace.
const INTERNAL_REALM = /(-INST\b|\bINST\b|^(?:US|EU|KR|TW|AU)\d|\bCWOW\b|\bVANWOW\b|\bPROGWOW\b|\bGMSS\b|\bCSI\b|^zzz|\bPTR\b|\bTest\b)/i;

const cache = new Map(); // `${region}:${game}` -> { expiresAt, realms }

function cacheKey(region, game) {
  return `${region}:${game}`;
}

function clearRealmCache() {
  cache.clear();
}

/**
 * Returns every realm for a region+game as `{ id, name, slug, internal }`,
 * sorted by name. Cached for six hours.
 */
async function getRealms(options = {}) {
  const region = options.region ?? DEFAULT_REGION;
  const game = options.game ?? DEFAULT_GAME;
  const key = cacheKey(region, game);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.realms;

  const index = await getRealmIndex({ ...options, region, game });

  const realms = (index.realms ?? [])
    .map(realm => ({
      id: realm.id,
      name: realm.name,
      slug: realm.slug,
      internal: INTERNAL_REALM.test(realm.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, realms });

  return realms;
}

/** Playable realms only — what a person actually wants to see or search. */
async function getPlayableRealms(options = {}) {
  return (await getRealms(options)).filter(realm => !realm.internal);
}

/** Exact match on name or slug, ignoring case, accents, and punctuation. */
function findRealm(realms, query) {
  const key = realmMatchKey(query);
  if (!key) return null;

  return (
    realms.find(realm => realmMatchKey(realm.name) === key || realmMatchKey(realm.slug) === key) ??
    null
  );
}

/** Substring match, for listings and "did you mean" suggestions. */
function searchRealms(realms, query) {
  const key = realmMatchKey(query);
  if (!key) return realms;

  return realms.filter(
    realm => realmMatchKey(realm.name).includes(key) || realmMatchKey(realm.slug).includes(key)
  );
}

/**
 * Resolves user input to a real realm. Falls back to a derived slug if the index
 * cannot be reached, so a transient failure degrades instead of breaking lookups.
 *
 * @returns {Promise<{slug: string, name: string, resolved: boolean}>}
 */
async function resolveRealm(query, options = {}) {
  try {
    const realm = findRealm(await getRealms(options), query);

    if (realm) {
      return { slug: realm.slug, name: realm.name, resolved: true };
    }
  } catch (err) {
    console.warn(`Could not read the realm index: ${err.message}`);
  }

  return { slug: slugifyRealm(query), name: String(query ?? ''), resolved: false };
}

module.exports = {
  CACHE_TTL_MS,
  INTERNAL_REALM,
  clearRealmCache,
  findRealm,
  getPlayableRealms,
  getRealms,
  resolveRealm,
  searchRealms
};
