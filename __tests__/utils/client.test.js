const {
  BlizzardApiError,
  OAUTH_TOKEN_URL,
  apiHost,
  getAccessToken,
  request,
  resetTokenCache
} = require('../../utils/blizzard/client');

const config = {
  blizzard: {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    region: 'us',
    locale: 'en_US'
  }
};

function response(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[String(name).toLowerCase()] ?? null },
    json: async () => body
  };
}

const tokenResponse = () => response({ access_token: 'access-token', expires_in: 86399 });

/** Routes OAuth calls to a token and everything else through `apiResponses` in order. */
function mockFetch(apiResponses) {
  const queue = [...apiResponses];

  return jest.fn(async url => {
    if (String(url).startsWith(OAUTH_TOKEN_URL)) return tokenResponse();

    const next = queue.shift();
    if (!next) throw new Error(`Unexpected API call to ${url}`);
    if (typeof next === 'function') return next();
    return next;
  });
}

beforeEach(() => {
  resetTokenCache();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  delete global.fetch;
});

describe('apiHost', () => {
  it('builds the regional API host', () => {
    expect(apiHost('us')).toBe('https://us.api.blizzard.com');
    expect(apiHost('eu')).toBe('https://eu.api.blizzard.com');
  });
});

describe('getAccessToken', () => {
  it('requests a token with HTTP basic auth and the client-credentials grant', async () => {
    global.fetch = jest.fn(async () => tokenResponse());

    await expect(getAccessToken({ config })).resolves.toBe('access-token');

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(OAUTH_TOKEN_URL);
    expect(options.method).toBe('POST');
    expect(options.body).toBe('grant_type=client_credentials');
    expect(options.headers.Authorization).toBe(
      `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`
    );
  });

  it('caches the token across calls', async () => {
    global.fetch = jest.fn(async () => tokenResponse());

    await getAccessToken({ config });
    await getAccessToken({ config });

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('de-dupes concurrent token requests', async () => {
    global.fetch = jest.fn(async () => tokenResponse());

    await Promise.all([getAccessToken({ config }), getAccessToken({ config })]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('re-requests once a cached token has expired', async () => {
    global.fetch = jest.fn(async () => response({ access_token: 'short', expires_in: 0 }));

    await getAccessToken({ config });
    await getAccessToken({ config });

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('explains a credential rejection', async () => {
    global.fetch = jest.fn(async () => response({}, { status: 401 }));

    await expect(getAccessToken({ config })).rejects.toThrow(/BLIZZARD_CLIENT_ID/);
  });

  it('reports other OAuth failures with the status', async () => {
    global.fetch = jest.fn(async () => response({}, { status: 503 }));

    await expect(getAccessToken({ config })).rejects.toThrow(/503/);
  });

  it('fails when the response omits a token', async () => {
    global.fetch = jest.fn(async () => response({}));

    await expect(getAccessToken({ config })).rejects.toThrow(/did not include an access token/);
  });

  it('surfaces a network failure', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('socket hang up');
    });

    await expect(getAccessToken({ config })).rejects.toThrow(/Could not reach Battle.net OAuth/);
  });

  it('refuses to call out when credentials are missing', async () => {
    global.fetch = jest.fn();

    await expect(
      getAccessToken({ config: { blizzard: { clientId: '', clientSecret: '' } } })
    ).rejects.toThrow(/credentials are not configured/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('allows a retry after a failed token request', async () => {
    global.fetch = jest
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('boom');
      })
      .mockImplementationOnce(async () => tokenResponse());

    await expect(getAccessToken({ config })).rejects.toThrow();
    await expect(getAccessToken({ config })).resolves.toBe('access-token');
  });
});

describe('request', () => {
  it('sends namespace, locale, and bearer token', async () => {
    global.fetch = mockFetch([response({ price: 1 })]);

    await expect(request('/data/wow/token/index', { namespace: 'dynamic', config })).resolves.toEqual(
      { price: 1 }
    );

    const [url, options] = global.fetch.mock.calls[1];
    expect(url.origin).toBe('https://us.api.blizzard.com');
    expect(url.pathname).toBe('/data/wow/token/index');
    expect(url.searchParams.get('namespace')).toBe('dynamic-us');
    expect(url.searchParams.get('locale')).toBe('en_US');
    expect(options.headers.Authorization).toBe('Bearer access-token');
  });

  it('honours a per-call region and locale', async () => {
    global.fetch = mockFetch([response({})]);

    await request('/data/wow/token/index', {
      namespace: 'dynamic',
      region: 'eu',
      locale: 'de_DE',
      config
    });

    const [url] = global.fetch.mock.calls[1];
    expect(url.origin).toBe('https://eu.api.blizzard.com');
    expect(url.searchParams.get('namespace')).toBe('dynamic-eu');
    expect(url.searchParams.get('locale')).toBe('de_DE');
  });

  it('appends extra search params and skips nullish ones', async () => {
    global.fetch = mockFetch([response({})]);

    await request('/data/wow/search/item', {
      namespace: 'static',
      config,
      searchParams: { 'name.en_US': 'Thunderfury', _page: 1, orderby: null, skipped: undefined }
    });

    const [url] = global.fetch.mock.calls[1];
    expect(url.searchParams.get('name.en_US')).toBe('Thunderfury');
    expect(url.searchParams.get('_page')).toBe('1');
    expect(url.searchParams.has('orderby')).toBe(false);
    expect(url.searchParams.has('skipped')).toBe(false);
  });

  it('throws a not-found error without retrying', async () => {
    global.fetch = mockFetch([response({}, { status: 404 })]);

    const error = await request('/missing', { namespace: 'profile', config }).catch(err => err);

    expect(error).toBeInstanceOf(BlizzardApiError);
    expect(error.isNotFound).toBe(true);
    expect(error.status).toBe(404);
  });

  it('does not retry other 4xx responses', async () => {
    global.fetch = mockFetch([response({}, { status: 403 })]);

    await expect(request('/forbidden', { namespace: 'profile', config })).rejects.toThrow(/403/);
    // One OAuth call plus a single API call.
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('re-authenticates once when the token is rejected', async () => {
    global.fetch = mockFetch([response({}, { status: 401 }), response({ ok: true })]);

    await expect(request('/data/wow/token/index', { namespace: 'dynamic', config })).resolves.toEqual(
      { ok: true }
    );

    // OAuth, 401, fresh OAuth, success.
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it('retries a rate-limited request', async () => {
    global.fetch = mockFetch([
      response({}, { status: 429, headers: { 'retry-after': '0' } }),
      response({ recovered: true })
    ]);

    await expect(request('/busy', { namespace: 'static', config })).resolves.toEqual({
      recovered: true
    });
  });

  it('gives up after repeated server errors', async () => {
    global.fetch = mockFetch([
      response({}, { status: 500 }),
      response({}, { status: 500 }),
      response({}, { status: 500 })
    ]);

    await expect(request('/broken', { namespace: 'static', config })).rejects.toThrow(/500/);
  });

  it('retries network failures before giving up', async () => {
    const boom = () => {
      throw new Error('ECONNRESET');
    };
    global.fetch = mockFetch([boom, boom, boom]);

    await expect(request('/flaky', { namespace: 'static', config })).rejects.toThrow(
      /Could not reach the Blizzard API/
    );
  });

  it('recovers when a network failure is transient', async () => {
    global.fetch = mockFetch([
      () => {
        throw new Error('ECONNRESET');
      },
      response({ recovered: true })
    ]);

    await expect(request('/flaky', { namespace: 'static', config })).resolves.toEqual({
      recovered: true
    });
  });
});
