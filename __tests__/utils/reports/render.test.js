jest.mock('fs');

const { buildSnapshot, diffSnapshots } = require('../../../utils/reports/diff');
const { characterKey } = require('../../../utils/reports/links');
const {
  MAX_FIELD_LENGTH,
  buildReportEmbed,
  describePeriod,
  formatChange,
  guildLabel,
  killLines,
  ladderLines,
  levelLines,
  listField,
  membershipLines,
  nameOf,
  rankLines
} = require('../../../utils/reports/render');

const GUILD = { name: 'Apex', realm: 'Nightslayer', realmSlug: 'nightslayer', region: 'us', seasonId: 3 };

function snapshot(members, capturedAt = 1_700_000_000_000) {
  return buildSnapshot({ guild: GUILD, capturedAt, members });
}

/** An embed field by name, from a built report. */
function field(embed, namePrefix) {
  return (embed.toJSON().fields ?? []).find(entry => entry.name.startsWith(namePrefix));
}

const BUTUD = {
  name: 'Butud',
  level: 70,
  className: 'Rogue',
  rank: 4,
  kills: 500,
  brackets: { '2v2': { rating: 1800, rank: 40, won: 10, lost: 5 } }
};

const OWNERS = new Map([[characterKey({ name: 'Butud', realm: 'nightslayer' }), '99']]);

describe('formatChange', () => {
  it('signs a gain', () => expect(formatChange(150)).toBe('+150'));
  it('signs a loss', () => expect(formatChange(-20)).toBe('-20'));
  it('omits a change of zero', () => expect(formatChange(0)).toBeNull());
  it('omits a change that is not a number', () => expect(formatChange(null)).toBeNull());
});

describe('nameOf', () => {
  it('adds a mention for a linked character', () => {
    expect(nameOf({ name: 'Butud' }, 'nightslayer', OWNERS)).toBe('**Butud** (<@99>)');
  });

  it('falls back to the character name when nobody has linked it', () => {
    expect(nameOf({ name: 'Stranger' }, 'nightslayer', OWNERS)).toBe('**Stranger**');
  });

  it('works with no owner index at all, which is the normal case at first', () => {
    expect(nameOf({ name: 'Butud' }, 'nightslayer', undefined)).toBe('**Butud**');
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
    expect(membershipLines([{ name: 'Butud', className: 'Rogue', level: 70 }], 'nightslayer', OWNERS)).toEqual(
      ['**Butud** (<@99>) — Rogue, level 70']
    );
  });

  it('omits detail it does not have', () => {
    expect(membershipLines([{ name: 'X' }], 'nightslayer', new Map())).toEqual(['**X**']);
  });

  it('celebrates hitting the cap', () => {
    expect(levelLines([{ name: 'X', from: 69, to: 70, cappedOut: true }], 'n', new Map()).at(0)).toContain('🎉');
  });

  it('does not celebrate an ordinary level', () => {
    expect(levelLines([{ name: 'X', from: 20, to: 21, cappedOut: false }], 'n', new Map()).at(0)).not.toContain(
      '🎉'
    );
  });

  it('shows a rank move in both directions', () => {
    expect(rankLines([{ name: 'X', from: 6, to: 2 }], 'n', new Map())).toEqual(['**X** — rank 6 → 2']);
  });

  it('shows rating movement on the ladder', () => {
    const lines = ladderLines(
      [{ name: 'X', rating: 1950, rank: 22, won: 20, lost: 7, isNew: false, ratingChange: 150 }],
      'n',
      new Map()
    );

    expect(lines.at(0)).toBe('`#22` **X** — 1,950 (+150) · 20W/7L');
  });

  it('marks a first appearance rather than inventing a gain', () => {
    const lines = ladderLines(
      [{ name: 'X', rating: 1500, rank: 900, won: 2, lost: 1, isNew: true, ratingChange: null }],
      'n',
      new Map()
    );

    expect(lines.at(0)).toContain('(new)');
  });

  it('suppresses the new marker on a first run, where everyone is new', () => {
    const lines = ladderLines(
      [{ name: 'X', rating: 1500, rank: 900, won: 2, lost: 1, isNew: true, ratingChange: null }],
      'n',
      new Map(),
      { isFirstRun: true }
    );

    expect(lines.at(0)).not.toContain('new');
  });

  it('leads with the weekly gain, keeping the lifetime total secondary', () => {
    expect(killLines([{ name: 'X', change: 300, total: 800 }], 'n', new Map()).at(0)).toBe(
      '**X** — **+300** (800 total)'
    );
  });
});

describe('guildLabel', () => {
  it('joins guild and realm', () => expect(guildLabel(GUILD)).toBe('Apex · Nightslayer'));
  it('tolerates a missing realm', () => expect(guildLabel({ name: 'Apex' })).toBe('Apex'));
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
  it('titles the report with the guild and realm', () => {
    const embed = buildReportEmbed({ diff: diffSnapshots(null, snapshot([BUTUD])) });
    expect(embed.toJSON().title).toBe('Weekly Report — Apex · Nightslayer');
  });

  it('always shows the headline totals', () => {
    const embed = buildReportEmbed({ diff: diffSnapshots(null, snapshot([BUTUD])) });

    expect(field(embed, 'Members').value).toBe('1');
    expect(field(embed, 'At Level 70').value).toBe('1');
    expect(field(embed, 'Arena Ranked').value).toBe('1');
  });

  it('reports joiners, leavers, level-ups and promotions', () => {
    const before = snapshot([{ ...BUTUD, level: 69, rank: 6 }, { name: 'Gone', level: 40 }]);
    const after = snapshot([BUTUD, { name: 'Newbie', level: 12 }]);

    const embed = buildReportEmbed({ diff: diffSnapshots(before, after) });

    expect(field(embed, '📥 Joined').value).toContain('Newbie');
    expect(field(embed, '📤 Left').value).toContain('Gone');
    expect(field(embed, '⬆️ Level-ups').value).toContain('69 → 70');
    expect(field(embed, '🎖️ Promotions').value).toContain('rank 6 → 4');
  });

  it('gives each arena bracket its own field', () => {
    const after = snapshot([
      { ...BUTUD, brackets: { '2v2': { rating: 1800, rank: 40, won: 10, lost: 5 } } },
      { name: 'Other', brackets: { '3v3': { rating: 2000, rank: 10, won: 30, lost: 9 } } }
    ]);

    const embed = buildReportEmbed({ diff: diffSnapshots(null, after) });

    expect(field(embed, '⚔️ 2v2')).toBeDefined();
    expect(field(embed, '⚔️ 3v3')).toBeDefined();
  });

  it('mentions the people who linked their characters', () => {
    const before = snapshot([{ ...BUTUD, kills: 100 }]);
    const embed = buildReportEmbed({ diff: diffSnapshots(before, snapshot([BUTUD])), owners: OWNERS });

    expect(field(embed, '💀 Honorable Kills').value).toContain('<@99>');
  });

  it('says so plainly when nothing happened', () => {
    const embed = buildReportEmbed({ diff: diffSnapshots(snapshot([]), snapshot([])) });
    expect(field(embed, 'Quiet week')).toBeDefined();
  });

  it('does not call a first report a quiet week', () => {
    const embed = buildReportEmbed({ diff: diffSnapshots(null, snapshot([])) });
    expect(field(embed, 'Quiet week')).toBeUndefined();
  });

  it('surfaces what could not be fetched', () => {
    const embed = buildReportEmbed({
      diff: diffSnapshots(null, snapshot([BUTUD])),
      warnings: ['3 of 240 honorable-kill lookups errored and were skipped.']
    });

    expect(field(embed, '⚠️ Incomplete').value).toContain('errored');
  });

  it('carries the season and region in the footer', () => {
    const embed = buildReportEmbed({ diff: diffSnapshots(null, snapshot([BUTUD])) });
    expect(embed.toJSON().footer.text).toBe('Season 3 • US');
  });

  it('never exceeds a field limit, even for a very large guild', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      name: `Averyveryverylongcharactername${i}`,
      level: 70,
      kills: 1000 + i
    }));

    const before = snapshot(many.map(m => ({ ...m, kills: 0, level: 69 })));
    const embed = buildReportEmbed({ diff: diffSnapshots(before, snapshot(many)) });

    for (const entry of embed.toJSON().fields) {
      expect(entry.value.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
    }
  });
});
