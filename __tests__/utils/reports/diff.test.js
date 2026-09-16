const {
  arenaChanges,
  buildSnapshot,
  deriveMaxLevel,
  diffSnapshots,
  killChanges,
  levelChanges,
  membershipChanges,
  rankChanges,
  totals
} = require('../../../utils/reports/diff');

/** A snapshot from a compact member list, so tests read as data. */
function snapshot(members, capturedAt = 1000) {
  return buildSnapshot({ guild: { name: 'Apex', realmSlug: 'nightslayer' }, capturedAt, members });
}

const BUTUD = {
  name: 'Butud',
  level: 70,
  className: 'Rogue',
  rank: 4,
  kills: 500,
  brackets: { '2v2': { rating: 1800, rank: 40, won: 10, lost: 5 } }
};

describe('buildSnapshot', () => {
  it('keys members case-insensitively, so a rename in casing is not a new member', () => {
    const built = snapshot([{ ...BUTUD, name: 'BUTUD' }]);
    expect(Object.keys(built.members)).toEqual(['butud']);
  });

  it('keeps the display casing for rendering', () => {
    expect(snapshot([{ ...BUTUD, name: 'BUTUD' }]).members.butud.name).toBe('BUTUD');
  });

  it('skips members with no name rather than storing a blank key', () => {
    expect(Object.keys(snapshot([{ level: 70 }]).members)).toEqual([]);
  });

  it('normalises missing numbers to null instead of NaN', () => {
    const member = snapshot([{ name: 'X' }]).members.x;
    expect(member).toMatchObject({ level: null, rank: null, kills: null, brackets: {} });
  });
});

describe('deriveMaxLevel', () => {
  it('reads the cap off the roster rather than hardcoding 70', () => {
    expect(deriveMaxLevel(snapshot([{ name: 'A', level: 70 }, { name: 'B', level: 62 }]))).toBe(70);
  });

  it('follows the cap upward when Blizzard raises it', () => {
    expect(deriveMaxLevel(snapshot([{ name: 'A', level: 80 }]))).toBe(80);
  });

  it('is null for an empty roster', () => {
    expect(deriveMaxLevel(snapshot([]))).toBeNull();
  });
});

describe('membershipChanges', () => {
  it('finds joiners and leavers', () => {
    const before = snapshot([BUTUD]);
    const after = snapshot([{ name: 'Newbie', level: 20 }]);

    const { joined, left } = membershipChanges(before, after);

    expect(joined).toEqual([expect.objectContaining({ name: 'Newbie' })]);
    expect(left).toEqual([expect.objectContaining({ name: 'Butud' })]);
  });

  it('lists the highest level first, so raiders lead', () => {
    const after = snapshot([
      { name: 'Low', level: 12 },
      { name: 'High', level: 70 }
    ]);

    expect(membershipChanges(snapshot([]), after).joined.map(m => m.name)).toEqual(['High', 'Low']);
  });
});

describe('levelChanges', () => {
  it('reports a level gain', () => {
    const before = snapshot([{ ...BUTUD, level: 69 }]);
    const after = snapshot([BUTUD]);

    expect(levelChanges(before, after, 70)).toEqual([
      expect.objectContaining({ name: 'Butud', from: 69, to: 70, cappedOut: true })
    ]);
  });

  it('flags only the character who crossed the cap this week', () => {
    const before = snapshot([{ ...BUTUD, level: 70 }, { name: 'B', level: 60 }]);
    const after = snapshot([{ ...BUTUD, level: 70 }, { name: 'B', level: 65 }]);

    expect(levelChanges(before, after, 70)).toEqual([
      expect.objectContaining({ name: 'B', cappedOut: false })
    ]);
  });

  it('ignores a level going backwards, which cannot really happen', () => {
    const before = snapshot([BUTUD]);
    const after = snapshot([{ ...BUTUD, level: 69 }]);

    expect(levelChanges(before, after, 70)).toEqual([]);
  });

  it('ignores members who were not there last week', () => {
    expect(levelChanges(snapshot([]), snapshot([BUTUD]), 70)).toEqual([]);
  });
});

describe('rankChanges', () => {
  it('treats a falling rank number as a promotion', () => {
    const before = snapshot([{ ...BUTUD, rank: 6 }]);
    const after = snapshot([{ ...BUTUD, rank: 2 }]);

    const { promotions, demotions } = rankChanges(before, after);

    expect(promotions).toEqual([expect.objectContaining({ from: 6, to: 2 })]);
    expect(demotions).toEqual([]);
  });

  it('treats a rising rank number as a demotion', () => {
    const before = snapshot([{ ...BUTUD, rank: 1 }]);
    const after = snapshot([{ ...BUTUD, rank: 5 }]);

    expect(rankChanges(before, after).demotions).toEqual([expect.objectContaining({ from: 1, to: 5 })]);
  });

  it('reports nothing when a rank is unchanged', () => {
    expect(rankChanges(snapshot([BUTUD]), snapshot([BUTUD])).promotions).toEqual([]);
  });
});

describe('arenaChanges', () => {
  it('reports a rating gain and a ladder climb', () => {
    const before = snapshot([BUTUD]);
    const after = snapshot([
      { ...BUTUD, brackets: { '2v2': { rating: 1950, rank: 22, won: 20, lost: 7 } } }
    ]);

    expect(arenaChanges(before, after, ['2v2']).at(0).entries.at(0)).toMatchObject({
      ratingChange: 150,
      // Rank 40 -> 22 is an improvement, so the reported change is positive.
      rankChange: 18,
      wonChange: 10,
      lostChange: 2,
      isNew: false
    });
  });

  it('marks a first appearance as new instead of a huge gain', () => {
    const entry = arenaChanges(snapshot([{ ...BUTUD, brackets: {} }]), snapshot([BUTUD]), ['2v2'])
      .at(0)
      .entries.at(0);

    expect(entry).toMatchObject({ isNew: true, ratingChange: null, rankChange: null });
  });

  it('sorts by rating, best first', () => {
    const after = snapshot([
      { name: 'Low', brackets: { '2v2': { rating: 1500, rank: 900, won: 1, lost: 1 } } },
      { name: 'High', brackets: { '2v2': { rating: 2400, rank: 2, won: 50, lost: 3 } } }
    ]);

    expect(arenaChanges(snapshot([]), after, ['2v2']).at(0).entries.map(e => e.name)).toEqual([
      'High',
      'Low'
    ]);
  });

  it('omits a bracket nobody is ranked in', () => {
    expect(arenaChanges(snapshot([]), snapshot([BUTUD]), ['3v3'])).toEqual([]);
  });
});

describe('killChanges', () => {
  it('reports the gain, not the lifetime total', () => {
    const before = snapshot([{ ...BUTUD, kills: 500 }]);
    const after = snapshot([{ ...BUTUD, kills: 800 }]);

    expect(killChanges(before, after)).toEqual([
      expect.objectContaining({ name: 'Butud', change: 300, total: 800 })
    ]);
  });

  it('drops an impossible decrease rather than reporting negative kills', () => {
    const before = snapshot([{ ...BUTUD, kills: 800 }]);
    const after = snapshot([{ ...BUTUD, kills: 500 }]);

    expect(killChanges(before, after)).toEqual([]);
  });

  it('ignores members with no kill data — a bank alt has no PvP summary', () => {
    const before = snapshot([{ ...BUTUD, kills: null }]);
    const after = snapshot([{ ...BUTUD, kills: null }]);

    expect(killChanges(before, after)).toEqual([]);
  });

  it('sorts by the weekly gain, not the lifetime figure', () => {
    const before = snapshot([
      { name: 'Veteran', kills: 9000 },
      { name: 'Grinder', kills: 100 }
    ]);
    const after = snapshot([
      { name: 'Veteran', kills: 9010 },
      { name: 'Grinder', kills: 900 }
    ]);

    expect(killChanges(before, after).map(k => k.name)).toEqual(['Grinder', 'Veteran']);
  });
});

describe('totals', () => {
  it('counts members, max-level characters, and ranked players', () => {
    const built = snapshot([BUTUD, { name: 'Alt', level: 30 }]);

    expect(totals(built, 70)).toEqual({ members: 2, atMaxLevel: 1, ranked: 1, kills: 500 });
  });
});

describe('diffSnapshots', () => {
  it('marks a first run and suppresses membership churn', () => {
    const diff = diffSnapshots(null, snapshot([BUTUD]));

    expect(diff.isFirstRun).toBe(true);
    // Without a baseline every member would read as a new recruit.
    expect(diff.joined).toEqual([]);
    expect(diff.left).toEqual([]);
    expect(diff.previousAt).toBeNull();
  });

  it('still shows current standings on a first run', () => {
    const diff = diffSnapshots(null, snapshot([BUTUD]));

    expect(diff.totals.members).toBe(1);
    expect(diff.arena.at(0).entries.at(0).name).toBe('Butud');
  });

  it('carries the period across for the renderer', () => {
    const diff = diffSnapshots(snapshot([BUTUD], 1000), snapshot([BUTUD], 9000));

    expect(diff).toMatchObject({ previousAt: 1000, capturedAt: 9000, isFirstRun: false });
  });

  it('produces an empty week when nothing moved', () => {
    const diff = diffSnapshots(snapshot([BUTUD]), snapshot([BUTUD]));

    expect(diff.joined).toEqual([]);
    expect(diff.levelUps).toEqual([]);
    expect(diff.promotions).toEqual([]);
    expect(diff.kills).toEqual([]);
  });
});
