const {
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
  return buildSnapshot({ guild: { name: 'Apex', region: 'eu' }, capturedAt, members });
}

const JUDY = {
  name: 'Judgement',
  surname: 'Judy',
  level: 10,
  className: 'Paladin',
  rank: 4,
  kills: 500
};

describe('buildSnapshot', () => {
  it('keys members by name and surname, case-insensitively', () => {
    const built = snapshot([{ ...JUDY, name: 'JUDGEMENT' }]);
    expect(Object.keys(built.members)).toEqual(['judgement-judy']);
  });

  it('keeps the display casing for rendering', () => {
    expect(snapshot([{ ...JUDY, name: 'JUDGEMENT' }]).members['judgement-judy'].name).toBe(
      'JUDGEMENT'
    );
  });

  it('skips members with no name rather than storing a blank key', () => {
    expect(Object.keys(snapshot([{ level: 10 }]).members)).toEqual([]);
  });

  it('keeps two members apart by surname alone', () => {
    const built = snapshot([
      { name: 'Judgement', surname: 'Judy', level: 10 },
      { name: 'Judgement', surname: 'Smith', level: 12 }
    ]);

    expect(Object.keys(built.members).sort()).toEqual(['judgement-judy', 'judgement-smith']);
  });

  it('normalises missing numbers to null instead of NaN', () => {
    const member = snapshot([{ name: 'X', surname: 'Y' }]).members['x-y'];
    expect(member).toMatchObject({ level: null, rank: null, kills: null });
  });
});

describe('deriveMaxLevel', () => {
  it('reads the cap off the roster rather than hardcoding it', () => {
    expect(
      deriveMaxLevel(snapshot([{ name: 'A', surname: 'X', level: 10 }, { name: 'B', surname: 'Y', level: 8 }]))
    ).toBe(10);
  });

  it('follows the cap upward if it ever moves', () => {
    expect(deriveMaxLevel(snapshot([{ name: 'A', surname: 'X', level: 20 }]))).toBe(20);
  });

  it('is null for an empty roster', () => {
    expect(deriveMaxLevel(snapshot([]))).toBeNull();
  });
});

describe('membershipChanges', () => {
  it('finds joiners and leavers', () => {
    const before = snapshot([JUDY]);
    const after = snapshot([{ name: 'Newbie', surname: 'Smith', level: 5 }]);

    const { joined, left } = membershipChanges(before, after);

    expect(joined).toEqual([expect.objectContaining({ name: 'Newbie' })]);
    expect(left).toEqual([expect.objectContaining({ name: 'Judgement' })]);
  });

  it('lists the highest level first, so leaders lead', () => {
    const after = snapshot([
      { name: 'Low', surname: 'A', level: 3 },
      { name: 'High', surname: 'B', level: 10 }
    ]);

    expect(membershipChanges(snapshot([]), after).joined.map(m => m.name)).toEqual(['High', 'Low']);
  });
});

describe('levelChanges', () => {
  it('reports a level gain', () => {
    const before = snapshot([{ ...JUDY, level: 9 }]);
    const after = snapshot([JUDY]);

    expect(levelChanges(before, after, 10)).toEqual([
      expect.objectContaining({ name: 'Judgement', from: 9, to: 10, cappedOut: true })
    ]);
  });

  it('flags only the character who crossed the cap this week', () => {
    const before = snapshot([{ ...JUDY, level: 10 }, { name: 'B', surname: 'X', level: 6 }]);
    const after = snapshot([{ ...JUDY, level: 10 }, { name: 'B', surname: 'X', level: 8 }]);

    expect(levelChanges(before, after, 10)).toEqual([
      expect.objectContaining({ name: 'B', cappedOut: false })
    ]);
  });

  it('ignores a level going backwards, which cannot really happen', () => {
    const before = snapshot([JUDY]);
    const after = snapshot([{ ...JUDY, level: 9 }]);

    expect(levelChanges(before, after, 10)).toEqual([]);
  });

  it('ignores members who were not there last week', () => {
    expect(levelChanges(snapshot([]), snapshot([JUDY]), 10)).toEqual([]);
  });
});

describe('rankChanges', () => {
  it('treats a falling rank number as a promotion', () => {
    const before = snapshot([{ ...JUDY, rank: 6 }]);
    const after = snapshot([{ ...JUDY, rank: 2 }]);

    const { promotions, demotions } = rankChanges(before, after);

    expect(promotions).toEqual([expect.objectContaining({ from: 6, to: 2 })]);
    expect(demotions).toEqual([]);
  });

  it('treats a rising rank number as a demotion', () => {
    const before = snapshot([{ ...JUDY, rank: 1 }]);
    const after = snapshot([{ ...JUDY, rank: 5 }]);

    expect(rankChanges(before, after).demotions).toEqual([expect.objectContaining({ from: 1, to: 5 })]);
  });

  it('reports nothing when a rank is unchanged', () => {
    expect(rankChanges(snapshot([JUDY]), snapshot([JUDY])).promotions).toEqual([]);
  });
});

describe('killChanges', () => {
  it('reports the gain, not the lifetime total', () => {
    const before = snapshot([{ ...JUDY, kills: 500 }]);
    const after = snapshot([{ ...JUDY, kills: 800 }]);

    expect(killChanges(before, after)).toEqual([
      expect.objectContaining({ name: 'Judgement', change: 300, total: 800 })
    ]);
  });

  it('drops an impossible decrease rather than reporting negative kills', () => {
    const before = snapshot([{ ...JUDY, kills: 800 }]);
    const after = snapshot([{ ...JUDY, kills: 500 }]);

    expect(killChanges(before, after)).toEqual([]);
  });

  it('ignores members with no kill data — a sub-level-10 character has no PvP summary', () => {
    const before = snapshot([{ ...JUDY, kills: null }]);
    const after = snapshot([{ ...JUDY, kills: null }]);

    expect(killChanges(before, after)).toEqual([]);
  });

  it('carries the surname through, since the renderer needs it to find the mention', () => {
    // Regression: this used to build its own object without `surname`, so a
    // kill gain could never be matched back to a linked character.
    const before = snapshot([{ ...JUDY, kills: 500 }]);
    const after = snapshot([{ ...JUDY, kills: 800 }]);

    expect(killChanges(before, after)).toEqual([expect.objectContaining({ surname: 'Judy' })]);
  });

  it('sorts by the weekly gain, not the lifetime figure', () => {
    const before = snapshot([
      { name: 'Veteran', surname: 'A', kills: 9000 },
      { name: 'Grinder', surname: 'B', kills: 100 }
    ]);
    const after = snapshot([
      { name: 'Veteran', surname: 'A', kills: 9010 },
      { name: 'Grinder', surname: 'B', kills: 900 }
    ]);

    expect(killChanges(before, after).map(k => k.name)).toEqual(['Grinder', 'Veteran']);
  });
});

describe('totals', () => {
  it('counts members and max-level characters', () => {
    const built = snapshot([JUDY, { name: 'Alt', surname: 'B', level: 3 }]);

    expect(totals(built, 10)).toEqual({ members: 2, atMaxLevel: 1, kills: 500 });
  });
});

describe('diffSnapshots', () => {
  it('marks a first run and suppresses membership churn', () => {
    const diff = diffSnapshots(null, snapshot([JUDY]));

    expect(diff.isFirstRun).toBe(true);
    // Without a baseline every member would read as a new recruit.
    expect(diff.joined).toEqual([]);
    expect(diff.left).toEqual([]);
    expect(diff.previousAt).toBeNull();
  });

  it('still shows current standings on a first run', () => {
    const diff = diffSnapshots(null, snapshot([JUDY]));

    expect(diff.totals.members).toBe(1);
    expect(diff.members[0]).toMatchObject({ name: 'Judgement', surname: 'Judy' });
  });

  it('carries the period across for the renderer', () => {
    const diff = diffSnapshots(snapshot([JUDY], 1000), snapshot([JUDY], 9000));

    expect(diff).toMatchObject({ previousAt: 1000, capturedAt: 9000, isFirstRun: false });
  });

  it('produces an empty week when nothing moved', () => {
    const diff = diffSnapshots(snapshot([JUDY]), snapshot([JUDY]));

    expect(diff.joined).toEqual([]);
    expect(diff.levelUps).toEqual([]);
    expect(diff.promotions).toEqual([]);
    expect(diff.kills).toEqual([]);
  });
});
