jest.mock('../../../utils/blizzard/client', () => {
  const actual = jest.requireActual('../../../utils/blizzard/client');
  return { request: jest.fn(), BlizzardApiError: actual.BlizzardApiError };
});

const { request, BlizzardApiError } = require('../../../utils/blizzard/client');
const {
  characterProbePath,
  patchFrom,
  probePath,
  readPatch,
  runChecks
} = require('../../../utils/namespaceWatch/probe');

beforeEach(() => jest.clearAllMocks());

function apiError(status) {
  return new BlizzardApiError(`Blizzard API returned ${status}.`, { status });
}

describe('characterProbePath', () => {
  it('builds a realmless character path from the configured slug', () => {
    // Forever characters are one path segment; there is no realm to insert.
    expect(characterProbePath('Judgement-Judy')).toBe('/profile/wow/character/judgement-judy');
  });

  it('returns null when no probe character is configured', () => {
    // The caller turns this into `skipped`. Inventing a name would 404 under a
    // perfectly healthy namespace and read as an outage.
    expect(characterProbePath(null)).toBeNull();
    expect(characterProbePath('')).toBeNull();
    expect(characterProbePath('   ')).toBeNull();
  });
});

describe('patchFrom', () => {
  it('finds a patch string in any payload', () => {
    expect(patchFrom([{}, null, { patch_string: '1.60.1' }])).toBe('1.60.1');
  });

  it('returns null when nothing reports one', () => {
    expect(patchFrom([{}, null])).toBeNull();
  });
});

describe('probePath', () => {
  it('reports a 200 as available', async () => {
    request.mockResolvedValue({ realms: [] });

    const result = await probePath('/data/wow/realm/index', 'dynamic', { region: 'us' });

    expect(result).toMatchObject({ status: 200, state: 'available' });
  });

  it('asks for the forever namespace', async () => {
    request.mockResolvedValue({});

    await probePath('/data/wow/realm/index', 'dynamic', { region: 'eu' });

    expect(request).toHaveBeenCalledWith('/data/wow/realm/index', expect.objectContaining({
      namespace: 'dynamic',
      game: 'forever',
      region: 'eu'
    }));
  });

  it('reads the status off a thrown BlizzardApiError rather than failing', async () => {
    request.mockRejectedValue(apiError(404));

    expect(await probePath('/x', 'dynamic', {})).toMatchObject({ status: 404, state: 'pending' });
  });

  it('distinguishes a refused namespace from an empty one', async () => {
    request.mockRejectedValue(apiError(403));

    expect(await probePath('/x', 'dynamic', {})).toMatchObject({ status: 403, state: 'rejected' });
  });

  it('calls a transport failure an error, never a pending namespace', async () => {
    request.mockRejectedValue(new Error('socket hang up'));

    const result = await probePath('/x', 'dynamic', {});

    expect(result.state).toBe('error');
    expect(result.status).toBeNull();
  });

  it('treats a BlizzardApiError with no status as an error', async () => {
    request.mockRejectedValue(new BlizzardApiError('credentials missing'));

    expect((await probePath('/x', 'dynamic', {})).state).toBe('error');
  });
});

describe('runChecks', () => {
  const checks = [
    { key: 'static.item', namespace: 'static', path: '/data/wow/item/19019', label: 'Items', unlocks: '/item' },
    { key: 'dynamic.realm-index', namespace: 'dynamic', path: '/data/wow/realm/index', label: 'Realms', unlocks: '/realms' },
    { key: 'profile.character', namespace: 'profile', path: null, requires: 'dynamic.realm-index', label: 'Characters', unlocks: '/character' }
  ];

  it('returns a state for every check', async () => {
    request.mockRejectedValue(apiError(404));

    const { results } = await runChecks({ region: 'us', checks });

    expect(results.map(result => result.key)).toEqual(checks.map(check => check.key));
  });

  it('blocks a dependent check while its prerequisite is not available', async () => {
    request.mockRejectedValue(apiError(404));

    const { results } = await runChecks({ region: 'us', checks });
    const profile = results.find(result => result.key === 'profile.character');

    expect(profile).toMatchObject({ state: 'blocked', blockedBy: 'dynamic.realm-index' });
  });

  it('does not spend a request on a blocked check', async () => {
    request.mockRejectedValue(apiError(404));

    await runChecks({ region: 'us', checks });

    // Two attempted, the third blocked.
    expect(request).toHaveBeenCalledTimes(2);
  });

  // The real profile check has no fixed path and no prerequisite: it is built
  // from the configured probe character instead.
  const characterChecks = [
    {
      key: 'profile.character',
      namespace: 'profile',
      path: null,
      needsCharacter: true,
      label: 'Characters',
      unlocks: '/character'
    }
  ];

  it('builds the character path from the configured probe character', async () => {
    request.mockResolvedValue({ name: 'Judgement', surname: 'Judy' });

    const { results } = await runChecks({
      region: 'eu',
      checks: characterChecks,
      character: 'judgement-judy'
    });

    expect(results[0]).toMatchObject({
      state: 'available',
      path: '/profile/wow/character/judgement-judy'
    });
  });

  it('skips the character check when no probe character is configured', async () => {
    request.mockResolvedValue({});

    const { results } = await runChecks({ region: 'eu', checks: characterChecks });

    // `skipped`, not `blocked`: nothing in the API is missing.
    expect(results[0]).toMatchObject({ state: 'skipped', status: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('reports a 200 listing with no rows as empty rather than available', async () => {
    // What `/data/wow/search/realm` actually does on this namespace. Calling it
    // available would say the collection works when it holds nothing.
    const counted = [
      {
        key: 'dynamic.ruleset-index',
        namespace: 'dynamic',
        path: '/data/wow/ruleset/index',
        label: 'Rulesets',
        rows: body => body?.rulesets?.length ?? null,
        unlocks: '/realms'
      }
    ];

    request.mockResolvedValue({ rulesets: [] });

    const { results } = await runChecks({ region: 'us', checks: counted });

    expect(results[0].state).toBe('empty');
  });

  it('surfaces a patch string from any payload it collected', async () => {
    request.mockResolvedValue({ patch_string: '1.60.1', realms: [{ slug: 'x' }] });

    expect((await runChecks({ region: 'us', checks })).patch).toBe('1.60.1');
  });

  it('keeps going after one check fails', async () => {
    // Three independent checks, so the only thing under test is that a failure
    // does not abandon the ones after it.
    const independent = [
      { key: 'a', namespace: 'static', path: '/a', label: 'A', unlocks: 'a' },
      { key: 'b', namespace: 'dynamic', path: '/b', label: 'B', unlocks: 'b' },
      { key: 'c', namespace: 'dynamic', path: '/c', label: 'C', unlocks: 'c' }
    ];

    request.mockImplementation(path =>
      path === '/a' ? Promise.reject(apiError(403)) : Promise.resolve({})
    );

    const { results } = await runChecks({ region: 'us', checks: independent });

    expect(results.map(result => result.state)).toEqual(['rejected', 'available', 'available']);
  });
});

describe('readPatch', () => {
  it('follows the region index to the region document', async () => {
    request
      .mockResolvedValueOnce({ regions: [{ href: 'https://us.api.blizzard.com/data/wow/region/91?namespace=dynamic-forever-us' }] })
      .mockResolvedValueOnce({ patch_string: '1.60.1', name: { en_US: 'CAMWOW North America' } });

    expect(await readPatch({ region: 'us' })).toEqual({
      patch: '1.60.1',
      regionName: 'CAMWOW North America'
    });
  });

  it('reads a plain-string name, which is what a localed request returns', async () => {
    // `request` sends a locale, so Blizzard collapses `name` to a string rather
    // than the { en_US: ... } map the raw endpoint hands back. Reaching for
    // `.en_US` here silently produced null; this is the regression guard.
    request
      .mockResolvedValueOnce({ regions: [{ href: '/data/wow/region/91' }] })
      .mockResolvedValueOnce({ patch_string: '1.60.1', name: 'CAMWOW North America' });

    expect(await readPatch({ region: 'us' })).toEqual({
      patch: '1.60.1',
      regionName: 'CAMWOW North America'
    });
  });

  it('still reads a localized map, for whichever endpoint returns one', async () => {
    request
      .mockResolvedValueOnce({ regions: [{ href: '/data/wow/region/91' }] })
      .mockResolvedValueOnce({ patch_string: '1.60.1', name: { en_US: 'CAMWOW North America' } });

    expect((await readPatch({ region: 'us' })).regionName).toBe('CAMWOW North America');
  });

  it('reports a missing patch string as null rather than guessing', async () => {
    request
      .mockResolvedValueOnce({ regions: [{ href: '/data/wow/region/91' }] })
      .mockResolvedValueOnce({ name: 'Somewhere' });

    expect(await readPatch({ region: 'us' })).toEqual({ patch: null, regionName: 'Somewhere' });
  });

  it('returns null when there is no region to follow', async () => {
    request.mockResolvedValue({ regions: [] });
    expect(await readPatch({ region: 'us' })).toBeNull();
  });

  it('returns null when the href carries no id', async () => {
    request.mockResolvedValue({ regions: [{ href: 'nonsense' }] });
    expect(await readPatch({ region: 'us' })).toBeNull();
  });

  it('never throws, because metadata must not colour an endpoint state', async () => {
    request.mockRejectedValue(apiError(404));
    expect(await readPatch({ region: 'us' })).toBeNull();
  });
});
