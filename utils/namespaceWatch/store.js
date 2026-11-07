// utils/namespaceWatch/store.js
// Last known state of each watched endpoint.
//
// AGENTS.md says not to add a store without a very good reason. This is the same
// reason `onboarding-warned.json` exists: without it, "announce when this
// changes" degrades into "announce on every restart", and a bot that restarts
// on deploy would post the same notice indefinitely until somebody muted the
// channel. The file holds nothing but endpoint keys, states and timestamps —
// no user data.
//
// Written atomically via a temp file and rename, matching `utils/audit/config.js`,
// so a crash mid-write cannot leave a truncated JSON file that would be read as
// "nothing has ever been seen" and re-announce everything.

const fs = require('fs');
const path = require('path');

const { STATES } = require('./checks');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'namespace-watch.json');

const DEFAULTS = {
  // `null` means "never polled", which is NOT the same as pending: the first
  // poll of a brand-new deployment must not announce the current state as news.
  lastCheckedAt: null,
  // Blizzard's own version string for the namespace, when it reports one.
  // A change here is the clearest signal that something moved.
  patch: null,
  endpoints: {}
};

let cache = null;

function normalizeState(value) {
  const state = String(value ?? '').trim().toLowerCase();
  return STATES.includes(state) ? state : null;
}

function normalizeTimestamp(value) {
  const at = Number(value);
  return Number.isFinite(at) && at > 0 ? at : null;
}

function normalizeEndpoint(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};

  return {
    state: normalizeState(source.state),
    since: normalizeTimestamp(source.since),
    status: Number.isFinite(Number(source.status)) ? Number(source.status) : null
  };
}

function normalizeStore(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const endpoints = {};

  for (const [key, value] of Object.entries(source.endpoints ?? {})) {
    const endpoint = normalizeEndpoint(value);
    // An unreadable state is dropped rather than guessed at. It reads as "never
    // seen", so the next poll re-establishes a baseline silently.
    if (endpoint.state) endpoints[key] = endpoint;
  }

  return {
    lastCheckedAt: normalizeTimestamp(source.lastCheckedAt),
    patch: (source.patch ?? null) === null ? null : String(source.patch),
    endpoints
  };
}

function load() {
  if (cache) return cache;

  try {
    cache = normalizeStore(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not read ${STORE_PATH}, starting fresh: ${err.message}`);
    }
    cache = normalizeStore(DEFAULTS);
  }

  return cache;
}

function save(changes = {}) {
  const next = normalizeStore({ ...load(), ...changes });

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tempPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, STORE_PATH);

  cache = next;
  return next;
}

/**
 * Folds a poll's results into the store.
 *
 * `since` is preserved across an unchanged state so the announcement can say
 * how long something has been that way, and reset when it changes.
 */
function recordResults(results, { now = Date.now(), patch = null } = {}) {
  const previous = load();
  const endpoints = { ...previous.endpoints };

  for (const result of results) {
    const before = previous.endpoints[result.key];

    endpoints[result.key] = {
      state: result.state,
      status: result.status ?? null,
      since: before && before.state === result.state ? before.since : now
    };
  }

  return save({
    lastCheckedAt: now,
    patch: patch ?? previous.patch,
    endpoints
  });
}

/** The recorded state of one endpoint, or null when it has never been polled. */
function stateOf(key, store = load()) {
  return store.endpoints[key]?.state ?? null;
}

function clearCache() {
  cache = null;
}

module.exports = {
  DEFAULTS,
  STORE_PATH,
  clearCache,
  load,
  normalizeStore,
  recordResults,
  save,
  stateOf
};
