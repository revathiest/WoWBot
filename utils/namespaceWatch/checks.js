// utils/namespaceWatch/checks.js
// What the watcher polls, and what each result would mean for the bot.
//
// This is a hand-maintained list because Blizzard has no discovery endpoint.
// `/data/wow/`, `/data/wow/index` and `/` all 404 — including on a namespace
// that definitely works, like `dynamic-us` — and there is no OpenAPI document
// anywhere under us.api.blizzard.com or develop.battle.net. So "which endpoints
// are live" cannot be asked; it can only be tested, one known path at a time.
//
// The list exists to catch REGRESSIONS now, not arrivals. When it was written,
// `forever` was half-published and the question was "can we support it yet?".
// That question is answered: the bot supports it, so what matters is being told
// if an endpoint it depends on stops answering. One canary per capability the
// bot actually uses.
//
// Deliberately free of discord.js and of `fetch`, so the whole list and its
// state machine are testable with plain objects.

/** The namespace this watcher exists for. A key of GAMES in `config/`. */
const WATCHED_GAME = 'forever';

/**
 * Result states.
 *
 *   available  200 with content — the dependent commands work
 *   empty      200 but zero rows — the collection is live and has nothing in it
 *   pending    404 — the namespace is accepted but Blizzard publishes no document
 *   rejected   403 — the namespace is not recognised, or not ours to read
 *   blocked    not attempted, because a prerequisite is not `available` yet
 *   skipped    not attempted, because nothing is configured to test it with
 *   error      the request failed for some other reason (5xx, timeout, OAuth)
 *
 * `empty` is its own state because of what `/data/wow/search/realm` taught us:
 * it answers 200 with `pageCount: 0` under this namespace, because Forever has
 * no realms at all. Folding that into `available` would have reported a live
 * endpoint as working when the thing behind it does not exist.
 */
const STATES = ['available', 'empty', 'pending', 'rejected', 'blocked', 'skipped', 'error'];

/**
 * Checks run in order, so a `requires` entry is always resolved before whatever
 * depends on it.
 *
 * `rows` counts the collection in a 200 payload, which is what separates
 * `available` from `empty`. Omit it when the document is a single object rather
 * than a listing — there is nothing to count.
 *
 * `unlocks` is written to be read in Discord by somebody who does not have this
 * file open — it says what becomes possible, not which function gets called.
 */
const CHECKS = [
  {
    key: 'static.playable-class',
    namespace: 'static',
    path: '/data/wow/playable-class/index',
    label: 'Playable classes (static)',
    rows: body => body?.classes?.length ?? null,
    unlocks: 'class names in guild rosters — roster entries carry only a class id'
  },
  {
    key: 'static.item',
    namespace: 'static',
    // Thunderfury: a fixed, long-lived id that exists in every flavour, so a
    // 404 here means the namespace, never a retired item.
    path: '/data/wow/item/19019',
    label: 'Item documents (static)',
    unlocks: '/item'
  },
  {
    key: 'dynamic.region',
    namespace: 'dynamic',
    path: '/data/wow/region/index',
    label: 'Region index (dynamic)',
    rows: body => body?.regions?.length ?? null,
    unlocks: 'nothing by itself — this is the canary proving the namespace is real'
  },
  {
    key: 'dynamic.ruleset-index',
    namespace: 'dynamic',
    path: '/data/wow/ruleset/index',
    label: 'Ruleset index (dynamic)',
    rows: body => body?.rulesets?.length ?? null,
    unlocks: '/realm and /realms — rulesets are this flavour\'s realms'
  },
  {
    key: 'profile.character',
    namespace: 'profile',
    // Filled in at run time from the configured probe character, because a
    // character path cannot be invented: a name nobody owns 404s under a
    // perfectly good namespace, which is indistinguishable from the namespace
    // being unpublished. Without one configured this check is `skipped`.
    path: null,
    needsCharacter: true,
    label: 'Character profiles (profile)',
    unlocks: '/character, /guild, /audit, /iam and the weekly report'
  }
];

const BY_KEY = new Map(CHECKS.map(check => [check.key, check]));

/** Maps an HTTP status onto a state, before the payload is considered. */
function stateForStatus(status) {
  if (status === 200) return 'available';
  if (status === 404) return 'pending';
  if (status === 403) return 'rejected';
  return 'error';
}

/**
 * Refines a 200 into `available` or `empty` using the check's row counter.
 *
 * A null count means "not a listing, or shape not recognised" and stays
 * `available`: reporting an unexpected payload shape as empty would invent a
 * regression out of a Blizzard field rename.
 */
function stateForPayload(check, status, body) {
  const state = stateForStatus(status);

  if (state !== 'available' || typeof check?.rows !== 'function') return state;

  const count = check.rows(body);

  return count === 0 ? 'empty' : 'available';
}

/**
 * Whether a change is worth posting about.
 *
 * `error` is never announced in either direction. A 5xx or a timed-out request
 * says nothing about Blizzard's data, and announcing it would turn one bad
 * afternoon into a stream of messages that trains everybody to ignore the
 * channel. The same reasoning covers `blocked` and `skipped` — both mean "we
 * did not look", which is never news about the API.
 */
function isAnnounceable(previous, next) {
  const quiet = new Set(['error', 'blocked', 'skipped']);

  if (previous === next) return false;
  if (quiet.has(next)) return false;
  if (quiet.has(previous)) return next === 'available';

  return true;
}

/** `available` after anything else is the good news this watcher exists for. */
function isArrival(previous, next) {
  return next === 'available' && previous !== 'available';
}

/**
 * Something that used to answer and now does not. Worth knowing immediately.
 *
 * `empty` counts: a ruleset index that answers with zero rulesets is a
 * regression, even though the endpoint itself is still up.
 */
function isRegression(previous, next) {
  const quiet = new Set(['error', 'blocked', 'skipped']);

  return previous === 'available' && next !== 'available' && !quiet.has(next);
}

module.exports = {
  BY_KEY,
  CHECKS,
  STATES,
  WATCHED_GAME,
  isAnnounceable,
  isArrival,
  isRegression,
  stateForPayload,
  stateForStatus
};
