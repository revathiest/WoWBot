// utils/blizzard/profile.js
// Character-facing endpoints from the WoW Profile API (namespace `profile-{region}`).

const { request } = require('./client');
const { encodeCharacterName } = require('../wow');

/**
 * Builds a character path from an ALREADY-RESOLVED realm slug.
 *
 * Do not slugify here. Blizzard's rule deletes hyphens, so applying it to a slug
 * that already contains one destroys it ("area-52" -> "area52") and every lookup
 * 404s. Callers resolve names to slugs with `resolveRealm` first.
 *
 * Pass a FALSY realmSlug for a realmless flavour (Classic Forever). The realm
 * segment is then omitted entirely and `characterName` is the whole address —
 * the `{name}-{surname}` slug from `characterSlug`, not a bare first name:
 *
 *   realm:     /profile/wow/character/area-52/thrall
 *   realmless: /profile/wow/character/judgement-judy
 *
 * Both shapes are real routes. Verified 2026-11-06: the realmless form 200s
 * under `profile-forever-eu` and the realm form 404s there, because Forever
 * publishes no realms at all.
 */
function characterPath(realmSlug, characterName, suffix = '') {
  const name = encodeCharacterName(characterName);
  const base = realmSlug ? `${realmSlug}/${name}` : name;

  return `/profile/wow/character/${base}${suffix}`;
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
