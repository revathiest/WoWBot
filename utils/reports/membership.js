// utils/reports/membership.js
// Working out which roster members are actually in the Discord.
//
// The bot has exactly one bridge between a WoW character and a Discord account:
// the links file, filled in by members with /iam or by an admin with
// /iam manage assign. So there are three states, not two, and conflating them
// would make the report lie:
//
//   on Discord   the character is linked, and that account is still in the server
//   left         the character is linked, but that account is no longer a member
//   unlinked     nobody has claimed the character — which includes people who
//                are in the server and have simply never run the command
//
// `left` and `unlinked` both count as "not on Discord" for the headline number,
// but they need different follow-up, so the detailed breakdown keeps them apart.

const { characterKey } = require('./links');

/**
 * Sorts a roster into the three states above.
 *
 * @param {object[]} members       From the snapshot: `{ name, level, className }`.
 * @param {string}   realmSlug     The guild's realm, for matching links.
 * @param {Map}      owners        Character key -> Discord user id.
 * @param {Set|null} presentUserIds Ids currently in the server, or null when
 *                                  the member list could not be read — in which
 *                                  case a link is taken at face value rather
 *                                  than reporting everybody as gone.
 */
function splitByDiscord(members, realmSlug, owners, presentUserIds = null) {
  const onDiscord = [];
  const left = [];
  const unlinked = [];

  for (const member of members) {
    const userId = owners?.get?.(characterKey({ name: member.name, realm: realmSlug })) ?? null;

    if (!userId) {
      unlinked.push({ ...member, userId: null });
      continue;
    }

    const entry = { ...member, userId };

    if (presentUserIds && !presentUserIds.has(userId)) left.push(entry);
    else onDiscord.push(entry);
  }

  return { onDiscord, left, unlinked };
}

/** Counts for the report header. */
function countByDiscord(split) {
  const notOnDiscord = split.left.length + split.unlinked.length;

  return {
    onDiscord: split.onDiscord.length,
    notOnDiscord,
    left: split.left.length,
    unlinked: split.unlinked.length,
    total: split.onDiscord.length + notOnDiscord
  };
}

/**
 * Ids of everybody currently in the server.
 *
 * Returns null rather than an empty set when the fetch fails: an empty set
 * would mean "nobody is here", and the report would claim the entire guild had
 * left Discord.
 */
async function fetchPresentUserIds(guild) {
  try {
    const members = await guild.members.fetch();
    return new Set([...members.keys()]);
  } catch (err) {
    console.warn(`⚠️  reports: could not read the member list for ${guild?.id}: ${err.message}`);
    return null;
  }
}

module.exports = { countByDiscord, fetchPresentUserIds, splitByDiscord };
