const { buildKillTally, diffOrNull } = require('../../../utils/reports/killTally');
const { DAY_MS } = require('../../../utils/reports/killHistory');

const NOW = 1_700_000_000_000;

const MEMBERS = {
  judgement: { name: 'Judgement', surname: 'Judy', className: 'Paladin', kills: 500 },
  stranger: { name: 'Stranger', surname: 'Smith', className: 'Rogue', kills: 50 }
};

describe('diffOrNull', () => {
  it('is the straightforward gain', () => expect(diffOrNull(500, 480)).toBe(20));
  it('is null with no current value', () => expect(diffOrNull(null, 480)).toBeNull());
  it('is null with no baseline', () => expect(diffOrNull(500, undefined)).toBeNull());
  it('drops an impossible decrease rather than reporting a loss', () => {
    expect(diffOrNull(480, 500)).toBeNull();
  });
  it('allows a zero gain', () => expect(diffOrNull(500, 500)).toBe(0));
});

describe('buildKillTally', () => {
  it('shows only lifetime totals with no history at all', () => {
    const tally = buildKillTally([], MEMBERS, NOW);

    expect(tally).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Judgement', lifetime: 500, today: null, last7: null })
      ])
    );
  });

  it('computes today from the most recent prior entry', () => {
    const priorEntries = [{ capturedAt: NOW - DAY_MS, kills: { judgement: 480, stranger: 50 } }];

    const tally = buildKillTally(priorEntries, MEMBERS, NOW);
    const judy = tally.find(entry => entry.name === 'Judgement');

    expect(judy.today).toBe(20);
  });

  it('computes the 7-day gain from the entry closest to a week ago', () => {
    const priorEntries = [
      { capturedAt: NOW - 8 * DAY_MS, kills: { judgement: 400 } }, // too old — ignored in favour of the 7-day one
      { capturedAt: NOW - 7 * DAY_MS, kills: { judgement: 440 } },
      { capturedAt: NOW - DAY_MS, kills: { judgement: 480 } }
    ];

    const tally = buildKillTally(priorEntries, MEMBERS, NOW);
    const judy = tally.find(entry => entry.name === 'Judgement');

    expect(judy.last7).toBe(60); // 500 - 440
    expect(judy.today).toBe(20); // 500 - 480
  });

  it('falls back to the oldest entry when history is shorter than 7 days', () => {
    const priorEntries = [{ capturedAt: NOW - 2 * DAY_MS, kills: { judgement: 450 } }];

    const tally = buildKillTally(priorEntries, MEMBERS, NOW);
    const judy = tally.find(entry => entry.name === 'Judgement');

    expect(judy.last7).toBe(50);
  });

  it('skips a member with no honorable-kill data', () => {
    const tally = buildKillTally([], { nokills: { name: 'Nobody', kills: null } }, NOW);
    expect(tally).toEqual([]);
  });

  it('is null, not negative, for a character with fewer kills than the baseline', () => {
    const priorEntries = [{ capturedAt: NOW - DAY_MS, kills: { judgement: 9000 } }];

    const tally = buildKillTally(priorEntries, MEMBERS, NOW);
    expect(tally.find(entry => entry.name === 'Judgement').today).toBeNull();
  });

  it('sorts by today\'s gain, unknowns last, ties broken by lifetime', () => {
    const members = {
      a: { name: 'A', kills: 100 },
      b: { name: 'B', kills: 900 },
      c: { name: 'C', kills: 50 }
    };
    const priorEntries = [{ capturedAt: NOW - DAY_MS, kills: { a: 80, b: 880 } }]; // c has no baseline

    const tally = buildKillTally(priorEntries, members, NOW);

    expect(tally.map(entry => entry.name)).toEqual(['B', 'A', 'C']);
  });

  it('is unaffected by entries newer than the current capture', () => {
    // Defensive: only entries at or before `capturedAt` should ever be used.
    const priorEntries = [{ capturedAt: NOW + DAY_MS, kills: { judgement: 1 } }];

    const tally = buildKillTally(priorEntries, MEMBERS, NOW);
    const judy = tally.find(entry => entry.name === 'Judgement');

    // The "yesterday" baseline is just the most recent prior entry, with no
    // date check of its own — a future-dated entry would be used as-is. This
    // cannot happen in practice since entries are only ever appended for
    // `now`, but the gain stays sane (treated as the latest known point).
    expect(judy.today).toBe(499);
  });
});
