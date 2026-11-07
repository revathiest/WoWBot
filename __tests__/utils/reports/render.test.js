jest.mock('fs');

const { buildSnapshot, diffSnapshots } = require('../../../utils/reports/diff');
const { characterKey } = require('../../../utils/reports/links');
const {
  MAX_FIELD_LENGTH,
  buildKillTallyComponents,
  buildReportEmbed,
  describePeriod,
  formatChange,
  guildLabel,
  killLines,
  killTallySummaryLines,
  levelLines,
  listField,
  membershipLines,
  nameOf,
  rankLines
} = require('../../../utils/reports/render');

const GUILD = { name: 'Circle of Lore', region: 'eu' };

function snapshot(members, capturedAt = 1_700_000_000_000) {
  return buildSnapshot({ guild: GUILD, capturedAt, members });
}

/** An embed field by name, from a built report. */
function field(embed, namePrefix) {
  return (embed.toJSON().fields ?? []).find(entry => entry.name.startsWith(namePrefix));
}

const JUDY = {
  name: 'Judgement',
  surname: 'Judy',
  level: 10,
  className: 'Paladin',
  rank: 4,
  kills: 500
};

const OWNERS = new Map([[characterKey({ name: 'Judgement', surname: 'Judy' }), '99']]);

describe('formatChange', () => {
  it('signs a gain', () => expect(formatChange(150)).toBe('+150'));
  it('signs a loss', () => expect(formatChange(-20)).toBe('-20'));
  it('omits a change of zero', () => expect(formatChange(0)).toBeNull());
  it('omits a change that is not a number', () => expect(formatChange(null)).toBeNull());
});

describe('nameOf', () => {
  it('shows the full name, and adds a mention for a linked character', () => {
    expect(nameOf({ name: 'Judgement', surname: 'Judy' }, OWNERS)).toBe(
      '**Judgement Judy** (<@99>)'
    );
  });

  it('falls back to the character name when nobody has linked it', () => {
    expect(nameOf({ name: 'Stranger', surname: 'Smith' }, OWNERS)).toBe('**Stranger Smith**');
  });

  it('works with no owner index at all, which is the normal case at first', () => {
    expect(nameOf({ name: 'Judgement', surname: 'Judy' }, undefined)).toBe('**Judgement Judy**');
  });
});

describe('listField', () => {
  it('keeps a short list intact', () => {
    expect(listField(['a', 'b'])).toBe('a\nb');
  });

  it('collapses the tail into a count', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`);
    expect(listField(lines, { max: 10 })).toContain('…and 15 more');
  });

  it('stays inside Discord\'s field limit even with long lines', () => {
    const lines = Array.from({ length: 10 }, () => 'x'.repeat(400));
    expect(listField(lines).length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
  });

  it('still reports the remainder when it truncates on length', () => {
    const lines = Array.from({ length: 10 }, () => 'x'.repeat(400));
    expect(listField(lines)).toContain('more');
  });
});

describe('line builders', () => {
  it('describes a joiner with class and level', () => {
    expect(
      membershipLines([{ name: 'Judgement', surname: 'Judy', className: 'Paladin', level: 10 }], OWNERS)
    ).toEqual(['**Judgement Judy** (<@99>) — Paladin, level 10']);
  });

  it('omits detail it does not have', () => {
    expect(membershipLines([{ name: 'X', surname: 'Y' }], new Map())).toEqual(['**X Y**']);
  });

  it('celebrates hitting the cap', () => {
    expect(
      levelLines([{ name: 'X', surname: 'Y', from: 9, to: 10, cappedOut: true }], new Map()).at(0)
    ).toContain('🎉');
  });

  it('does not celebrate an ordinary level', () => {
    expect(
      levelLines([{ name: 'X', surname: 'Y', from: 4, to: 5, cappedOut: false }], new Map()).at(0)
    ).not.toContain('🎉');
  });

  it('shows a rank move in both directions', () => {
    expect(rankLines([{ name: 'X', surname: 'Y', from: 6, to: 2 }], new Map())).toEqual([
      '**X Y** — rank 6 → 2'
    ]);
  });

  it('leads with the weekly gain, keeping the lifetime total secondary', () => {
    expect(killLines([{ name: 'X', surname: 'Y', change: 300, total: 800 }], new Map()).at(0)).toBe(
      '**X Y** — **+300** (800 total)'
    );
  });
});

describe('killTallySummaryLines', () => {
  it('only shows members who gained kills today', () => {
    const lines = killTallySummaryLines([
      { name: 'Gainer', surname: 'One', today: 12, last7: 40, lifetime: 500 },
      { name: 'Quiet', surname: 'Two', today: 0, last7: 10, lifetime: 100 },
      { name: 'Unknown', surname: 'Three', today: null, last7: null, lifetime: 50 }
    ]);

    expect(lines).toEqual(['**Gainer One** — **+12**']);
  });

  it('adds a mention for a linked character', () => {
    const lines = killTallySummaryLines(
      [{ name: 'Judgement', surname: 'Judy', today: 12, last7: 40, lifetime: 500 }],
      OWNERS
    );

    expect(lines[0]).toContain('<@99>');
  });

  it('caps the list', () => {
    const tally = Array.from({ length: 10 }, (_, i) => ({
      name: `C${i}`,
      surname: 'Smith',
      today: 10 - i,
      last7: 0,
      lifetime: 0
    }));

    expect(killTallySummaryLines(tally, new Map(), { max: 3 })).toHaveLength(3);
  });
});

describe('buildKillTallyComponents', () => {
  it('builds one button per guild', () => {
    const rows = buildKillTallyComponents([{ key: 'a', name: 'Apex' }, { key: 'b', name: 'Second' }]);
    const buttons = rows.flatMap(row => row.components);

    expect(buttons).toHaveLength(2);
    expect(buttons[0].data.custom_id).toBe('report:kills:a');
  });

  it('splits into rows of five', () => {
    const guilds = Array.from({ length: 7 }, (_, i) => ({ key: `g${i}`, name: `Guild ${i}` }));
    const rows = buildKillTallyComponents(guilds);

    expect(rows).toHaveLength(2);
    expect(rows[0].components).toHaveLength(5);
    expect(rows[1].components).toHaveLength(2);
  });
});

describe('guildLabel', () => {
  it('is just the guild name — there is no realm', () => {
    expect(guildLabel(GUILD)).toBe('Circle of Lore');
  });

  it('tolerates a missing guild', () => expect(guildLabel(undefined)).toBe(''));
});

describe('describePeriod', () => {
  it('explains a first run instead of implying a quiet week', () => {
    expect(describePeriod({ isFirstRun: true })).toContain('First report');
  });

  it('links back to the previous report', () => {
    expect(describePeriod({ isFirstRun: false, previousAt: 1_700_000_000_000 })).toContain('<t:');
  });

  it('copes with no usable previous timestamp', () => {
    expect(describePeriod({ isFirstRun: false, previousAt: null })).toBe('Changes since the last report.');
  });
});

describe('buildReportEmbed', () => {
  it('titles the report with just the guild name', () => {
    const embed = buildReportEmbed({ diff: diffSnapshots(null, snapshot([JUDY])) });
    expect(embed.toJSON().title).toBe('Weekly Report — Circle of Lore');
  });

  it('always shows the headline totals', () => {
    const embed = buildReportEmbed({ diff: diffSnapshots(null, snapshot([JUDY])) });

    expect(field(embed, 'Members').value).toBe('1');
    expect(field(embed, 'At Level 10').value).toBe('1');
  });

  it('reports joiners, leavers, level-ups and promotions', () => {
    const before = snapshot([
      { ...JUDY, level: 9, rank: 6 },
      { name: 'Gone', surname: 'Smith', level: 8 }
    ]);
    const after = snapshot([JUDY, { name: 'Newbie', surname: 'Smith', level: 3 }]);

    const embed = buildReportEmbed({ diff: diffSnapshots(before, after) });

    expect(field(embed, '📥 Joined').value).toContain('Newbie');
    expect(field(embed, '📤 Left').value).toContain('Gone');
    expect(field(embed, '⬆️ Level-ups').value).toContain('9 → 10');
    expect(field(embed, '🎖️ Promotions').value).toContain('rank 6 → 4');
  });

  it('mentions the people who linked their characters', () => {
    const before = snapshot([{ ...JUDY, kills: 100 }]);
    const embed = buildReportEmbed({ diff: diffSnapshots(before, snapshot([JUDY])), owners: OWNERS });

    expect(field(embed, '💀 Honorable Kills').value).toContain('<@99>');
  });

  it('says so plainly when nothing happened', () => {
    const embed = buildReportEmbed({ diff: diffSnapshots(snapshot([]), snapshot([])) });
    expect(field(embed, 'Quiet week')).toBeDefined();
  });

  it('is not a quiet week when only the kill tally has news', () => {
    const embed = buildReportEmbed({
      diff: diffSnapshots(snapshot([]), snapshot([])),
      killTally: [{ name: 'Gainer', surname: 'One', today: 5, last7: 5, lifetime: 5 }]
    });

    expect(field(embed, 'Quiet week')).toBeUndefined();
    expect(field(embed, '📅 Most Kills Today').value).toContain('Gainer');
  });

  it('does not call a first report a quiet week', () => {
    const embed = buildReportEmbed({ diff: diffSnapshots(null, snapshot([])) });
    expect(field(embed, 'Quiet week')).toBeUndefined();
  });

  it('surfaces what could not be fetched', () => {
    const embed = buildReportEmbed({
      diff: diffSnapshots(null, snapshot([JUDY])),
      warnings: ['3 of 33 honorable-kill lookups errored and were skipped.']
    });

    expect(field(embed, '⚠️ Incomplete').value).toContain('errored');
  });

  it('carries the region in the footer', () => {
    const embed = buildReportEmbed({ diff: diffSnapshots(null, snapshot([JUDY])) });
    expect(embed.toJSON().footer.text).toBe('EU');
  });

  it('never exceeds a field limit, even for a very large guild', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      name: `Averyveryverylongcharactername${i}`,
      surname: 'Smith',
      level: 10,
      kills: 1000 + i
    }));

    const before = snapshot(many.map(m => ({ ...m, kills: 0, level: 9 })));
    const embed = buildReportEmbed({ diff: diffSnapshots(before, snapshot(many)) });

    for (const entry of embed.toJSON().fields) {
      expect(entry.value.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
    }
  });
});
