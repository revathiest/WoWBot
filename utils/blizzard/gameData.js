// utils/blizzard/gameData.js
// Game Data API endpoints. Rulesets are `dynamic-{region}`; items are `static-{region}`.

const { request } = require('./client');
const { readConfig } = require('../../config');

/**
 * Every ruleset id in the region. Rulesets are Classic Forever's replacement for
 * realms — `/data/wow/realm/index` 404s permanently, and `/data/wow/search/realm`
 * answers 200 with zero rows, so the realm collection is not unpublished, it is
 * structurally empty.
 *
 * The entries carry ONLY `{ id, key.href }`: no name, no status. Listing them
 * with names therefore costs one request per ruleset, which is why
 * `utils/blizzard/rulesets.js` caches the assembled list rather than the index.
 */
function getRulesetIndex(options = {}) {
  return request('/data/wow/ruleset/index', { ...options, namespace: 'dynamic' });
}

/** A single ruleset: id, name, up/down status, and its auction-house link. */
function getRuleset(rulesetId, options = {}) {
  return request(`/data/wow/ruleset/${rulesetId}`, { ...options, namespace: 'dynamic' });
}

/**
 * Auction houses for one ruleset.
 *
 * The trailing slash is REQUIRED — without it Blizzard 404s. That is not a
 * convention anywhere else in this API, so leave it alone.
 */
function getRulesetAuctionIndex(rulesetId, options = {}) {
  return request(`/data/wow/ruleset/${rulesetId}/auctions/`, { ...options, namespace: 'dynamic' });
}

/**
 * Playable classes for the game version.
 *
 * Needed because guild rosters identify a member's class by id only, with no
 * name alongside it — resolving the name is on whatever wants to print one.
 */
function getPlayableClassIndex(options = {}) {
  return request('/data/wow/playable-class/index', { ...options, namespace: 'static' });
}

/** Full item document for a known item id. */
function getItem(itemId, options = {}) {
  return request(`/data/wow/item/${itemId}`, { ...options, namespace: 'static' });
}

/** Item icon and other art assets. */
function getItemMedia(itemId, options = {}) {
  return request(`/data/wow/media/item/${itemId}`, { ...options, namespace: 'static' });
}

/**
 * Item search. Blizzard matches the localized name field exactly (case-insensitively)
 * rather than doing substring search, so the caller should pass a full item name.
 */
function searchItems(name, options = {}) {
  const config = options.config ?? readConfig();
  const locale = options.locale ?? config.blizzard.locale;

  return request('/data/wow/search/item', {
    ...options,
    config,
    namespace: 'static',
    searchParams: {
      [`name.${locale}`]: name,
      orderby: 'id',
      _page: 1,
      ...(options.searchParams ?? {})
    }
  });
}

module.exports = {
  getItem,
  getItemMedia,
  getPlayableClassIndex,
  getRuleset,
  getRulesetAuctionIndex,
  getRulesetIndex,
  searchItems
};
