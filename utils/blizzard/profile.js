// utils/blizzard/profile.js
// Character-facing endpoints from the WoW Profile API (namespace `profile-{region}`).
//
// Classic Forever characters have no realm: the whole address is one
// `{name}-{surname}` slug — `/profile/wow/character/judgement-judy` 200s,
// verified 2026-11-06, with `realm: null`, a `surname` field, and a `ruleset`
// reference in place of a realm. Build the slug with `characterSlug` from
// `utils/wow.js`.

const { request } = require('./client');

function characterPath(characterSlug, suffix = '') {
  return `/profile/wow/character/${characterSlug}${suffix}`;
}

/** Character summary: level, class, surname, ruleset, guild, item level. */
function getCharacterProfile(characterSlug, options = {}) {
  return request(characterPath(characterSlug), { ...options, namespace: 'profile' });
}

/** Avatar, inset, and full-body render URLs. */
function getCharacterMedia(characterSlug, options = {}) {
  return request(characterPath(characterSlug, '/character-media'), {
    ...options,
    namespace: 'profile'
  });
}

/** Equipped items, including item level and enchants per slot. */
function getCharacterEquipment(characterSlug, options = {}) {
  return request(characterPath(characterSlug, '/equipment'), {
    ...options,
    namespace: 'profile'
  });
}

/**
 * Honorable-kill count and rank. This is the vanilla honour system — Forever
 * has no arena (added in The Burning Crusade) — but the summary itself 200s
 * and carries real data, which is what the weekly report's kill tracking uses.
 */
function getCharacterPvpSummary(characterSlug, options = {}) {
  return request(characterPath(characterSlug, '/pvp-summary'), {
    ...options,
    namespace: 'profile'
  });
}

module.exports = {
  characterPath,
  getCharacterEquipment,
  getCharacterMedia,
  getCharacterProfile,
  getCharacterPvpSummary
};
