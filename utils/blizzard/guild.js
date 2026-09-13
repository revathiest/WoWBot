// utils/blizzard/guild.js
// Guild roster lookups.
//
// There is no guild index to resolve names against, unlike realms, so the slug
// has to be derived. Blizzard uses the same rule it uses for realms — lowercase,
// drop punctuation, spaces become hyphens — verified against real guilds, but
// with no index to check against, a miss is reported to the user rather than
// silently guessed at a second time.

const { request } = require('./client');
const { slugifyRealm } = require('../wow');

/** Guild names slug exactly like realm names. */
function slugifyGuild(name) {
  return slugifyRealm(name);
}

/** Full member list: name, level, playable class, and guild rank. */
function getGuildRoster(realmSlug, guildSlug, options = {}) {
  return request(`/data/wow/guild/${realmSlug}/${guildSlug}/roster`, {
    ...options,
    namespace: 'profile'
  });
}

/** Guild profile: name, faction, realm, member count, achievement points. */
function getGuild(realmSlug, guildSlug, options = {}) {
  return request(`/data/wow/guild/${realmSlug}/${guildSlug}`, {
    ...options,
    namespace: 'profile'
  });
}

module.exports = { getGuild, getGuildRoster, slugifyGuild };
