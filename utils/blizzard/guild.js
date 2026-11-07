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

/**
 * Builds a guild path.
 *
 * Pass a FALSY realmSlug for a realmless flavour (Classic Forever), which drops
 * the realm segment the same way character paths do:
 *
 *   realm:     /data/wow/guild/area-52/some-guild
 *   realmless: /data/wow/guild/circle-of-lore
 *
 * Verified 2026-11-06: the realmless form 200s under `profile-forever-eu`, and
 * the guild reference inside a Forever character profile points at exactly that
 * shape — so a guild slug taken from a character needs no realm to resolve.
 */
function guildPath(realmSlug, guildSlug, suffix = '') {
  const base = realmSlug ? `${realmSlug}/${guildSlug}` : guildSlug;

  return `/data/wow/guild/${base}${suffix}`;
}

/** Full member list: name, level, playable class, and guild rank. */
function getGuildRoster(realmSlug, guildSlug, options = {}) {
  return request(guildPath(realmSlug, guildSlug, '/roster'), {
    ...options,
    namespace: 'profile'
  });
}

/** Guild profile: name, faction, realm, member count, achievement points. */
function getGuild(realmSlug, guildSlug, options = {}) {
  return request(guildPath(realmSlug, guildSlug), {
    ...options,
    namespace: 'profile'
  });
}

module.exports = { getGuild, getGuildRoster, guildPath, slugifyGuild };
