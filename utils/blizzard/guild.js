// utils/blizzard/guild.js
// Guild roster lookups.
//
// Classic Forever guilds are ONE path segment, with no realm: Blizzard replaced
// realms with rulesets (see utils/blizzard/rulesets.js), and a guild hangs off
// the profile namespace by slug alone — `/data/wow/guild/circle-of-lore` 200s,
// verified 2026-11-06, and the guild reference inside a character profile points
// at exactly that shape.
//
// There is no guild index to resolve names against, either, so the slug has to
// be derived. Blizzard uses the same rule it uses for realm names — lowercase,
// drop punctuation, spaces become hyphens — verified against real guilds, but
// with no index to check against, a miss is reported to the user rather than
// silently guessed at a second time.

const { request } = require('./client');
const { slugifyRealm } = require('../wow');

/** Guild names slug the same way realm names used to. */
function slugifyGuild(name) {
  return slugifyRealm(name);
}

function guildPath(guildSlug, suffix = '') {
  return `/data/wow/guild/${guildSlug}${suffix}`;
}

/** Full member list: name, surname, level, playable class, and guild rank. */
function getGuildRoster(guildSlug, options = {}) {
  return request(guildPath(guildSlug, '/roster'), { ...options, namespace: 'profile' });
}

/** Guild profile: name, faction, member count, achievement points. */
function getGuild(guildSlug, options = {}) {
  return request(guildPath(guildSlug), { ...options, namespace: 'profile' });
}

module.exports = { getGuild, getGuildRoster, guildPath, slugifyGuild };
