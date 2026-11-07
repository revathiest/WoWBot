const {
  BY_KEY,
  CHECKS,
  STATES,
  WATCHED_GAME,
  isAnnounceable,
  isArrival,
  isRegression,
  stateForPayload,
  stateForStatus
} = require('../../../utils/namespaceWatch/checks');

describe('the check list', () => {
  it('watches the forever namespace', () => {
    expect(WATCHED_GAME).toBe('forever');
  });

  it('has a unique key per check', () => {
    const keys = CHECKS.map(check => check.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('indexes every check by key', () => {
    CHECKS.forEach(check => expect(BY_KEY.get(check.key)).toBe(check));
  });

  it('only uses the three real namespace prefixes', () => {
    CHECKS.forEach(check => expect(['static', 'dynamic', 'profile']).toContain(check.namespace));
  });

  it('explains what each check unlocks, so the Discord message is readable alone', () => {
    CHECKS.forEach(check => expect(typeof check.unlocks).toBe('string'));
  });

  it('explains how every check with no fixed path gets one', () => {
    // A null path is filled in either from another check's response or from the
    // configured probe character. Without one of those it could never run.
    CHECKS.filter(check => check.path === null).forEach(check => {
      if (check.needsCharacter) {
        expect(check.needsCharacter).toBe(true);
        return;
      }

      expect(check.requires).toBeTruthy();
      expect(BY_KEY.has(check.requires)).toBe(true);
    });
  });

  it('orders dependencies before the checks that need them', () => {
    const seen = new Set();

    CHECKS.forEach(check => {
      if (check.requires) expect(seen.has(check.requires)).toBe(true);
      seen.add(check.key);
    });
  });

  it('covers the ruleset index, which is what this flavour has instead of realms', () => {
    expect(BY_KEY.has('dynamic.ruleset-index')).toBe(true);
  });

  it('does not watch the realm index, which is permanently empty here', () => {
    // `/data/wow/realm/index` 404s and `/data/wow/search/realm` answers with
    // pageCount 0: Forever has no realms by design, so a check on either would
    // never go green and would read as a permanent outage.
    expect(BY_KEY.has('dynamic.realm-index')).toBe(false);
    expect(BY_KEY.has('dynamic.connected-realm-index')).toBe(false);
  });

  it('does not watch endpoints the game cannot have', () => {
    // No WoW Token and no arena in 1.60.1 — the whole reason /token and /arena
    // were removed from the bot entirely. Polling them would post an outage
    // every time nothing changed.
    expect(BY_KEY.has('dynamic.token')).toBe(false);
    expect(BY_KEY.has('dynamic.pvp-season')).toBe(false);
  });
});

describe('stateForStatus', () => {
  it('maps 200 to available', () => {
    expect(stateForStatus(200)).toBe('available');
  });

  it('maps 404 to pending, because the namespace was accepted', () => {
    expect(stateForStatus(404)).toBe('pending');
  });

  it('maps 403 to rejected, because the namespace was not', () => {
    expect(stateForStatus(403)).toBe('rejected');
  });

  it.each([500, 502, 429, 0, null, undefined])('treats %s as an error', status => {
    expect(stateForStatus(status)).toBe('error');
  });

  it('only ever returns a known state', () => {
    [200, 403, 404, 500].forEach(status => expect(STATES).toContain(stateForStatus(status)));
  });
});

describe('isAnnounceable', () => {
  it('says nothing when the state has not moved', () => {
    STATES.forEach(state => expect(isAnnounceable(state, state)).toBe(false));
  });

  it('announces an endpoint coming online', () => {
    expect(isAnnounceable('pending', 'available')).toBe(true);
    expect(isAnnounceable('rejected', 'available')).toBe(true);
  });

  it('announces a namespace that stops being accepted', () => {
    expect(isAnnounceable('pending', 'rejected')).toBe(true);
  });

  it('never announces an error, so a Blizzard outage is not a message storm', () => {
    STATES.forEach(state => expect(isAnnounceable(state, 'error')).toBe(false));
  });

  it('never announces a check it did not run', () => {
    STATES.forEach(state => expect(isAnnounceable(state, 'blocked')).toBe(false));
  });

  it('recovers quietly from an error unless the news is good', () => {
    expect(isAnnounceable('error', 'pending')).toBe(false);
    expect(isAnnounceable('error', 'available')).toBe(true);
    expect(isAnnounceable('blocked', 'pending')).toBe(false);
    expect(isAnnounceable('blocked', 'available')).toBe(true);
  });
});

describe('isArrival and isRegression', () => {
  it('counts a move to available as an arrival', () => {
    expect(isArrival('pending', 'available')).toBe(true);
    expect(isArrival('available', 'available')).toBe(false);
  });

  it('counts losing a working endpoint as a regression', () => {
    expect(isRegression('available', 'pending')).toBe(true);
    expect(isRegression('available', 'rejected')).toBe(true);
  });

  it('does not call a transient failure a regression', () => {
    expect(isRegression('available', 'error')).toBe(false);
    expect(isRegression('available', 'blocked')).toBe(false);
  });
});

describe('row counters', () => {
  // Each counter reads the collection out of a real payload shape. They are what
  // separate "the endpoint answers" from "the endpoint answers with nothing".
  const cases = [
    ['static.playable-class', { classes: [{ id: 1 }, { id: 2 }] }, 2],
    ['dynamic.region', { regions: [{ id: 91 }] }, 1],
    ['dynamic.ruleset-index', { rulesets: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 15 }] }, 4]
  ];

  it.each(cases)('counts the rows for %s', (key, payload, expected) => {
    expect(BY_KEY.get(key).rows(payload)).toBe(expected);
  });

  it.each(cases)('reports zero rows for an empty %s payload', key => {
    const check = BY_KEY.get(key);
    // An empty collection, keyed the way the real payload is.
    const field = { 'static.playable-class': 'classes', 'dynamic.region': 'regions', 'dynamic.ruleset-index': 'rulesets' }[key];

    expect(check.rows({ [field]: [] })).toBe(0);
  });

  it.each(cases)('returns null for an unrecognised %s shape', key => {
    // Null means "shape not recognised", which must not be read as empty — a
    // Blizzard field rename would otherwise invent a regression.
    expect(BY_KEY.get(key).rows({})).toBeNull();
    expect(BY_KEY.get(key).rows(null)).toBeNull();
  });

  it('gives the single-document checks no counter, since there is nothing to count', () => {
    expect(BY_KEY.get('static.item').rows).toBeUndefined();
    expect(BY_KEY.get('profile.character').rows).toBeUndefined();
  });
});

describe('stateForPayload', () => {
  const counted = { rows: body => body?.rulesets?.length ?? null };

  it('calls a 200 with rows available', () => {
    expect(stateForPayload(counted, 200, { rulesets: [{ id: 1 }] })).toBe('available');
  });

  it('calls a 200 with no rows empty', () => {
    expect(stateForPayload(counted, 200, { rulesets: [] })).toBe('empty');
  });

  it('leaves an unrecognised shape as available rather than inventing a regression', () => {
    expect(stateForPayload(counted, 200, {})).toBe('available');
  });

  it('leaves checks with no counter alone', () => {
    expect(stateForPayload({}, 200, {})).toBe('available');
    expect(stateForPayload(null, 200, {})).toBe('available');
  });

  it('passes non-200 statuses straight through', () => {
    expect(stateForPayload(counted, 404, null)).toBe('pending');
    expect(stateForPayload(counted, 403, null)).toBe('rejected');
    expect(stateForPayload(counted, 500, null)).toBe('error');
  });
});

describe('the quiet states', () => {
  it('never announces a move into skipped', () => {
    // "We did not look" is not news about the API.
    expect(isAnnounceable('available', 'skipped')).toBe(false);
    expect(isAnnounceable('pending', 'skipped')).toBe(false);
  });

  it('announces recovery out of skipped only when it goes live', () => {
    expect(isAnnounceable('skipped', 'available')).toBe(true);
    expect(isAnnounceable('skipped', 'pending')).toBe(false);
  });

  it('treats an endpoint that empties out as a regression', () => {
    // A ruleset index answering with zero rulesets is a regression even though
    // the endpoint itself is still up.
    expect(isRegression('available', 'empty')).toBe(true);
    expect(isAnnounceable('available', 'empty')).toBe(true);
  });

  it('does not call a skip or an error a regression', () => {
    expect(isRegression('available', 'skipped')).toBe(false);
    expect(isRegression('available', 'error')).toBe(false);
  });

  it('counts a move from empty to available as an arrival', () => {
    expect(isArrival('empty', 'available')).toBe(true);
  });

  it('lists every state the machine can produce', () => {
    ['available', 'empty', 'pending', 'rejected', 'blocked', 'skipped', 'error'].forEach(state =>
      expect(STATES).toContain(state)
    );
  });
});
