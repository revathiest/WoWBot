// utils/namespaceWatch/probe.js
// Runs the check list against the Blizzard API and classifies each result.
//
// Goes through `utils/blizzard/client.js` like everything else — it stays the
// only module that calls `fetch` or knows about OAuth. That also means the
// probe inherits the retry-on-5xx behaviour for free, so a transient blip
// becomes a retry rather than a false `error`.
//
// `request` THROWS for every non-2xx, so the status has to be read off the
// BlizzardApiError rather than from a response object. A 403 and a 404 are both
// ordinary outcomes here, not failures.

const { request, BlizzardApiError } = require('../blizzard/client');
const { localized } = require('../wow');
const { CHECKS, WATCHED_GAME, stateForPayload, stateForStatus } = require('./checks');

/**
 * The path for the character check, from the configured probe character.
 *
 * Forever characters are realmless: the whole address is one `{name}-{surname}`
 * slug, so a path needs a real character and cannot be derived. Returns null
 * when none is configured, which the caller reports as `skipped` rather than
 * guessing a name and reading its 404 as a dead namespace.
 */
function characterProbePath(character) {
  const slug = String(character ?? '').trim().toLowerCase();

  return slug ? `/profile/wow/character/${slug}` : null;
}

/** Blizzard's version string for the namespace, when it volunteers one. */
function patchFrom(payloads) {
  for (const payload of payloads) {
    const patch = payload?.patch_string;
    if (patch) return String(patch);
  }

  return null;
}

/**
 * Probes one path.
 *
 * Returns a plain result rather than throwing: the caller wants a state for
 * every check, including the ones that failed.
 */
async function probePath(path, namespace, { region, game = WATCHED_GAME, timeoutMs, check = null } = {}) {
  try {
    const body = await request(path, { namespace, game, region, timeoutMs });
    // A 200 is not automatically good news: a listing with no rows means the
    // collection is live and empty. See `stateForPayload`.
    return { status: 200, state: stateForPayload(check, 200, body), body };
  } catch (err) {
    if (err instanceof BlizzardApiError && Number.isFinite(err.status)) {
      return { status: err.status, state: stateForStatus(err.status), body: null };
    }

    // A timeout, a DNS failure, or OAuth being unreachable. Says nothing about
    // the namespace, so it must not read as `pending`.
    return { status: null, state: 'error', body: null, note: err.message };
  }
}

/**
 * Runs every check once.
 *
 * Sequential on purpose. There are five requests on a six-hour timer, so
 * parallelism buys nothing measurable and would make the rate-limit retry in
 * `client.js` fight itself.
 *
 * @param {string|null} character  The probe character for the profile check, as
 *                                 a `{name}-{surname}` slug. Without one the
 *                                 profile check is `skipped`.
 * @returns {Promise<{results: Array, patch: string|null}>}
 */
async function runChecks({ region, checks = CHECKS, timeoutMs, character = null, now = Date.now() } = {}) {
  const results = [];
  const byKey = new Map();
  const payloads = [];

  for (const check of checks) {
    // A check that depends on another waits for it, and is reported as blocked
    // rather than quietly skipped — "we did not look" is a real state.
    if (check.requires && byKey.get(check.requires)?.state !== 'available') {
      results.push({
        key: check.key,
        state: 'blocked',
        status: null,
        blockedBy: check.requires,
        at: now
      });
      byKey.set(check.key, { state: 'blocked' });
      continue;
    }

    const path = check.needsCharacter ? characterProbePath(character) : check.path;

    // `skipped`, not `blocked`: nothing in the API is missing, there is simply
    // no character configured to ask about. Saying "blocked" would imply
    // Blizzard was the holdup.
    if (!path) {
      results.push({
        key: check.key,
        state: 'skipped',
        status: null,
        note: 'No probe character configured (NAMESPACE_WATCH_CHARACTER).',
        at: now
      });
      byKey.set(check.key, { state: 'skipped' });
      continue;
    }

    const outcome = await probePath(path, check.namespace, { region, timeoutMs, check });

    if (outcome.body) payloads.push(outcome.body);

    results.push({
      key: check.key,
      state: outcome.state,
      status: outcome.status,
      note: outcome.note ?? null,
      path,
      at: now
    });
    byKey.set(check.key, { state: outcome.state });
  }

  return { results, patch: patchFrom(payloads) };
}

/**
 * Follows the region index to read the namespace's patch string.
 *
 * Separate from the check list because it is two requests for one piece of
 * metadata, and a failure here must not colour any endpoint's state.
 */
async function readPatch({ region, timeoutMs } = {}) {
  try {
    const index = await request('/data/wow/region/index', {
      namespace: 'dynamic',
      game: WATCHED_GAME,
      region,
      timeoutMs
    });

    const href = index?.regions?.[0]?.href;
    if (!href) return null;

    const id = String(href).match(/\/region\/(\d+)/)?.[1];
    if (!id) return null;

    const document = await request(`/data/wow/region/${id}`, {
      namespace: 'dynamic',
      game: WATCHED_GAME,
      region,
      timeoutMs
    });

    return {
      patch: document?.patch_string ? String(document.patch_string) : null,
      // `request` sends a locale, so Blizzard collapses `name` to a plain string
      // here rather than returning the `{ en_US: ... }` map the raw endpoint
      // gives. `localized` handles both, which is why reaching for `.en_US`
      // directly silently yielded null.
      regionName: localized(document?.name)
    };
  } catch {
    return null;
  }
}

module.exports = { characterProbePath, patchFrom, probePath, readPatch, runChecks };
