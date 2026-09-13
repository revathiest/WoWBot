// utils/blizzard/client.js
// Thin wrapper over the Battle.net API: OAuth client-credentials token handling,
// namespace/locale plumbing, timeouts, and retries for rate limits.

const { readConfig, buildNamespace } = require('../../config');

// Blizzard's unified OAuth endpoint. Region-agnostic; the same token works everywhere
// except China, which sits behind a separate gateway and is not supported here.
const OAUTH_TOKEN_URL = 'https://oauth.battle.net/token';

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;

// Refresh a little early so a token never expires mid-flight.
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

class BlizzardApiError extends Error {
  constructor(message, { status = null, path = null, body = null } = {}) {
    super(message);
    this.name = 'BlizzardApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }

  get isNotFound() {
    return this.status === 404;
  }
}

function apiHost(region) {
  return `https://${region}.api.blizzard.com`;
}

let tokenCache = null; // { accessToken, expiresAt }
let inFlightToken = null; // de-dupes concurrent token fetches

// Exposed for tests and for forcing a refresh after a credential change.
function resetTokenCache() {
  tokenCache = null;
  inFlightToken = null;
}

async function fetchAccessToken({ clientId, clientSecret, timeoutMs }) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  let response;
  try {
    response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new BlizzardApiError(`Could not reach Battle.net OAuth: ${err.message}`, {
      path: OAUTH_TOKEN_URL
    });
  }

  if (!response.ok) {
    throw new BlizzardApiError(
      response.status === 401
        ? 'Battle.net rejected the API credentials. Check BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET.'
        : `Battle.net OAuth returned ${response.status}.`,
      { status: response.status, path: OAUTH_TOKEN_URL }
    );
  }

  const payload = await response.json();

  if (!payload || !payload.access_token) {
    throw new BlizzardApiError('Battle.net OAuth response did not include an access token.', {
      path: OAUTH_TOKEN_URL
    });
  }

  // expires_in is in seconds and is typically ~24h.
  const lifetimeMs = Number(payload.expires_in ?? 0) * 1000;

  return {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max(lifetimeMs - TOKEN_EXPIRY_SKEW_MS, 0)
  };
}

async function getAccessToken({ config = readConfig(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken;
  }

  if (!inFlightToken) {
    const { clientId, clientSecret } = config.blizzard;

    if (!clientId || !clientSecret) {
      throw new BlizzardApiError('Blizzard API credentials are not configured.');
    }

    inFlightToken = fetchAccessToken({ clientId, clientSecret, timeoutMs })
      .then(token => {
        tokenCache = token;
        return token.accessToken;
      })
      .finally(() => {
        inFlightToken = null;
      });
  }

  return inFlightToken;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response.headers?.get?.('retry-after'));

  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 5000);
  }

  return 250 * 2 ** (attempt - 1); // 250ms, 500ms, ...
}

/**
 * Performs an authenticated GET against the Battle.net API.
 *
 * @param {string} path        Path beginning with a slash, e.g. `/data/wow/token/index`.
 * @param {object} options
 * @param {string} options.namespace  One of `profile`, `static`, `dynamic`.
 * @param {string} [options.region]   Defaults to the configured region.
 * @param {string} [options.game]     `retail`, `classic`, or `classic-era`.
 * @param {string} [options.locale]   Defaults to the configured locale.
 * @param {object} [options.searchParams] Extra query string values.
 * @returns {Promise<object>} Parsed JSON body.
 */
async function request(path, options = {}) {
  const config = options.config ?? readConfig();
  const region = options.region ?? config.blizzard.region;
  const locale = options.locale ?? config.blizzard.locale;
  const game = options.game ?? config.blizzard.game;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const url = new URL(path, apiHost(region));

  url.searchParams.set('namespace', buildNamespace(options.namespace, game, region));
  url.searchParams.set('locale', locale);

  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const accessToken = await getAccessToken({ config, timeoutMs });

    let response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      lastError = new BlizzardApiError(`Could not reach the Blizzard API: ${err.message}`, { path });

      if (attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(retryDelayMs({}, attempt));
      continue;
    }

    if (response.ok) {
      return response.json();
    }

    // An expired or revoked token: drop the cache so the next attempt re-authenticates.
    if (response.status === 401) {
      resetTokenCache();
      lastError = new BlizzardApiError('Blizzard API rejected the access token.', {
        status: 401,
        path
      });

      if (attempt === MAX_ATTEMPTS) throw lastError;
      continue;
    }

    if (response.status === 404) {
      throw new BlizzardApiError('Not found.', { status: 404, path });
    }

    // 429 (rate limited) and 5xx are worth another try; everything else is not.
    if (response.status !== 429 && response.status < 500) {
      throw new BlizzardApiError(`Blizzard API returned ${response.status}.`, {
        status: response.status,
        path
      });
    }

    lastError = new BlizzardApiError(`Blizzard API returned ${response.status}.`, {
      status: response.status,
      path
    });

    if (attempt === MAX_ATTEMPTS) throw lastError;
    await sleep(retryDelayMs(response, attempt));
  }

  throw lastError;
}

module.exports = {
  BlizzardApiError,
  OAUTH_TOKEN_URL,
  apiHost,
  getAccessToken,
  request,
  resetTokenCache
};
