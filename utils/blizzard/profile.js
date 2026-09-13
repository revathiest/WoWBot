// utils/blizzard/profile.js
// Character-facing endpoints from the WoW Profile API (namespace `profile-{region}`).

const { request } = require('./client');
const { slugifyRealm, encodeCharacterName } = require('../wow');

function characterPath(realm, characterName, suffix = '') {
  const realmSlug = slugifyRealm(realm);
  const name = encodeCharacterName(characterName);
  return `/profile/wow/character/${realmSlug}/${name}${suffix}`;
}

/** Character summary: level, class, spec, guild, item level, achievement points. */
function getCharacterProfile(realm, characterName, options = {}) {
  return request(characterPath(realm, characterName), { ...options, namespace: 'profile' });
}

/** Avatar, inset, and full-body render URLs. */
function getCharacterMedia(realm, characterName, options = {}) {
  return request(characterPath(realm, characterName, '/character-media'), {
    ...options,
    namespace: 'profile'
  });
}

/** Equipped items, including item level and enchants per slot. */
function getCharacterEquipment(realm, characterName, options = {}) {
  return request(characterPath(realm, characterName, '/equipment'), {
    ...options,
    namespace: 'profile'
  });
}

/** Mythic Keystone index: current rating plus this period's runs. */
function getMythicKeystoneProfile(realm, characterName, options = {}) {
  return request(characterPath(realm, characterName, '/mythic-keystone-profile'), {
    ...options,
    namespace: 'profile'
  });
}

/** Best runs and rating for one Mythic+ season. */
function getMythicKeystoneSeason(realm, characterName, seasonId, options = {}) {
  return request(characterPath(realm, characterName, `/mythic-keystone-profile/season/${seasonId}`), {
    ...options,
    namespace: 'profile'
  });
}

module.exports = {
  characterPath,
  getCharacterEquipment,
  getCharacterMedia,
  getCharacterProfile,
  getMythicKeystoneProfile,
  getMythicKeystoneSeason
};
