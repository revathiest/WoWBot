// utils/blizzard/gameData.js
// Game Data API endpoints. Realm/token data is `dynamic-{region}`; items are `static-{region}`.

const { request } = require('./client');
const { readConfig } = require('../../config');
const { slugifyRealm } = require('../wow');

/** Current WoW Token price, in copper, plus the time it was last updated. */
function getWowTokenPrice(options = {}) {
  return request('/data/wow/token/index', { ...options, namespace: 'dynamic' });
}

/** Every realm in the region, used to resolve and suggest realm names. */
function getRealmIndex(options = {}) {
  return request('/data/wow/realm/index', { ...options, namespace: 'dynamic' });
}

/** A single realm: type, timezone, category, and its connected-realm reference. */
function getRealm(realm, options = {}) {
  return request(`/data/wow/realm/${slugifyRealm(realm)}`, { ...options, namespace: 'dynamic' });
}

/** Connected realm: up/down status, population, queue flag, and member realms. */
function getConnectedRealm(connectedRealmId, options = {}) {
  return request(`/data/wow/connected-realm/${connectedRealmId}`, {
    ...options,
    namespace: 'dynamic'
  });
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
  getConnectedRealm,
  getItem,
  getItemMedia,
  getRealm,
  getRealmIndex,
  getWowTokenPrice,
  searchItems
};
