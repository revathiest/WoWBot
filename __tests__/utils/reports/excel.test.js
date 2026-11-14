const ExcelJS = require('exceljs');

const { buildSnapshot, diffSnapshots } = require('../../../utils/reports/diff');
const { characterKey } = require('../../../utils/reports/links');
const { buildKillTally } = require('../../../utils/reports/killTally');
const {
  MAX_SHEET_NAME,
  buildReportWorkbook,
  buildReportWorkbookBuffer,
  changeRows,
  historyRows,
  killTallyRows,
  linkedTo,
  rosterRows,
  sheetName,
  uniqueSheetName
} = require('../../../utils/reports/excel');

const GUILD = { name: 'Circle of Lore', region: 'eu' };

function snapshot(members, capturedAt = 1_700_000_000_000) {
  return buildSnapshot({ guild: GUILD, capturedAt, members });
}

/** Reads a sheet's rows back as plain objects, keyed the way the column defs name them. */
function readSheet(workbook, name) {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) return null;

  const keys = sheet.columns.map(col => col.key);
  const rows = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const entry = {};
    keys.forEach((key, index) => {
      entry[key] = row.getCell(index + 1).value;
    });
    rows.push(entry);
  });

  return rows;
}

describe('sheetName', () => {
  it('strips characters Excel forbids in a sheet name', () => {
    expect(sheetName('A/B:C*D?E[F]')).toBe('A B C D E F');
  });

  it('truncates to the Excel limit', () => {
    expect(sheetName('x'.repeat(50)).length).toBe(MAX_SHEET_NAME);
  });

  it('falls back to a generic name when nothing survives', () => {
    expect(sheetName('///')).toBe('Sheet');
  });
});

describe('uniqueSheetName', () => {
  it('leaves the first use of a name alone', () => {
    const used = new Set();
    expect(uniqueSheetName(used, 'Apex Roster')).toBe('Apex Roster');
  });

  it('disambiguates a repeated name', () => {
    const used = new Set();
    uniqueSheetName(used, 'Apex Roster');
    expect(uniqueSheetName(used, 'Apex Roster')).toBe('Apex Roster (2)');
  });

  it('keeps disambiguated names within the Excel limit', () => {
    const used = new Set();
    const long = 'x'.repeat(40);
    uniqueSheetName(used, long);
    const second = uniqueSheetName(used, long);
    expect(second.length).toBeLessThanOrEqual(MAX_SHEET_NAME);
  });
});

describe('linkedTo', () => {
  const owners = new Map([[characterKey({ name: 'Judgement', surname: 'Judy' }), '99']]);

  it('resolves a Discord tag when one is available', () => {
    expect(linkedTo({ name: 'Judgement', surname: 'Judy' }, owners, () => 'Judy#0001')).toBe(
      'Judy#0001'
    );
  });

  it('falls back to the bare id when no tag resolver is given', () => {
    expect(linkedTo({ name: 'Judgement', surname: 'Judy' }, owners)).toBe('99');
  });

  it('is blank when nobody has claimed the character', () => {
    expect(linkedTo({ name: 'Stranger', surname: 'Smith' }, owners)).toBe('');
  });
});

describe('row builders', () => {
  const previous = snapshot([
    { name: 'Judgement', surname: 'Judy', level: 60, className: 'Paladin', rank: 4, kills: 100 }
  ], 1_700_000_000_000);

  const current = snapshot(
    [
      { name: 'Judgement', surname: 'Judy', level: 70, className: 'Paladin', rank: 2, kills: 150 },
      { name: 'Newcomer', surname: 'Smith', level: 1, className: 'Warrior', rank: 5, kills: 0 }
    ],
    1_700_600_000_000
  );

  const diff = diffSnapshots(previous, current);

  it('rosterRows lists every current member, with lifetime kills and who claimed them', () => {
    const killsByKey = new Map([[characterKey({ name: 'Judgement', surname: 'Judy' }), 150]]);
    const owners = new Map([[characterKey({ name: 'Judgement', surname: 'Judy' }), '99']]);

    const rows = rosterRows(diff, killsByKey, owners, () => 'Judy#0001');

    expect(rows).toEqual([
      { character: 'Judgement Judy', className: 'Paladin', level: 70, lifetimeKills: 150, linked: 'Judy#0001' },
      { character: 'Newcomer Smith', className: 'Warrior', level: 1, lifetimeKills: '', linked: '' }
    ]);
  });

  it('changeRows covers joins, level-ups, and promotions as one typed list', () => {
    const rows = changeRows(diff);
    const byType = Object.fromEntries(rows.map(row => [`${row.type}:${row.character}`, row]));

    expect(byType['Joined:Newcomer Smith']).toMatchObject({ className: 'Warrior', level: 1 });
    expect(byType['Level up:Judgement Judy'].detail).toBe('60 → 70 (hit the cap)');
    expect(byType['Promotion:Judgement Judy'].detail).toBe('rank 4 → 2');
    expect(byType['Honorable kills:Judgement Judy'].detail).toBe('+50 (150 total)');
  });

  it('killTallyRows carries today/7-day/lifetime straight through', () => {
    const tally = buildKillTally([], current.members, current.capturedAt);
    const rows = killTallyRows(tally);

    expect(rows.find(row => row.character === 'Judgement Judy')).toMatchObject({
      className: 'Paladin',
      lifetime: 150
    });
  });

  it('changeRows falls back to blanks when a change has no class or level, and covers both sides of "hit the cap"', () => {
    const sparse = {
      joined: [{ name: 'A', surname: 'B' }],
      left: [{ name: 'C', surname: 'D' }],
      levelUps: [{ name: 'E', surname: 'F', from: 10, to: 20, cappedOut: false }],
      promotions: [{ name: 'G', surname: 'H', from: 5, to: 3 }],
      kills: [{ name: 'I', surname: 'J', change: 1, total: 2 }]
    };

    const rows = changeRows(sparse);

    expect(rows.find(row => row.type === 'Joined')).toMatchObject({ className: '', level: '' });
    expect(rows.find(row => row.type === 'Left')).toMatchObject({ className: '', level: '' });

    const levelUp = rows.find(row => row.type === 'Level up');
    expect(levelUp.detail).toBe('10 → 20');
    expect(levelUp.className).toBe('');

    expect(rows.find(row => row.type === 'Promotion')).toMatchObject({ className: '', level: '' });
    expect(rows.find(row => row.type === 'Honorable kills').className).toBe('');
  });

  it('rosterRows and killTallyRows fall back to blanks when class, level, or kill figures are missing', () => {
    const sparseDiff = { members: [{ name: 'K', surname: 'L' }] };
    const rows = rosterRows(sparseDiff, new Map(), new Map());
    expect(rows[0]).toMatchObject({ className: '', level: '', lifetimeKills: '' });

    const tallyRows = killTallyRows([{ name: 'M', surname: 'N', lifetime: 5 }]);
    expect(tallyRows[0]).toMatchObject({ className: '', today: '', last7: '' });
  });

  it('rosterRows treats a missing member list as empty, rather than throwing', () => {
    expect(rosterRows({}, new Map(), new Map())).toEqual([]);
  });

  it('changeRows leaves the level blank when a level-up has no "to" level', () => {
    const rows = changeRows({
      joined: [],
      left: [],
      levelUps: [{ name: 'O', surname: 'P', from: 10, to: null, cappedOut: false }],
      promotions: [],
      kills: []
    });

    expect(rows[0].level).toBe('');
  });

  it('historyRows turns a stored entry into a dated row', () => {
    const rows = historyRows([
      { capturedAt: 1_700_000_000_000, members: 10, atMaxLevel: 2, joined: 1, left: 0, levelUps: 1, promotions: 0, demotions: 0, killsGained: 40 }
    ]);

    expect(rows[0]).toMatchObject({ members: 10, killsGained: 40 });
    expect(rows[0].date).toBeInstanceOf(Date);
  });
});

describe('buildReportWorkbook', () => {
  const previous = snapshot([
    { name: 'Judgement', surname: 'Judy', level: 60, className: 'Paladin', rank: 4, kills: 100 }
  ], 1_700_000_000_000);

  const current = snapshot(
    [{ name: 'Judgement', surname: 'Judy', level: 70, className: 'Paladin', rank: 2, kills: 150 }],
    1_700_600_000_000
  );

  const diff = diffSnapshots(previous, current);
  const killTally = buildKillTally([], current.members, current.capturedAt);

  it('writes a Roster, Changes, and Kill Tally sheet per guild', () => {
    const workbook = buildReportWorkbook([{ key: 'g1', guild: GUILD, diff, killTally }]);

    expect(readSheet(workbook, 'Circle of Lore Roster')).toEqual([
      { character: 'Judgement Judy', className: 'Paladin', level: 70, lifetimeKills: 150, linked: '' }
    ]);
    expect(readSheet(workbook, 'Circle of Lore Changes').length).toBeGreaterThan(0);
    expect(readSheet(workbook, 'Circle of Lore Kill Tally').length).toBe(1);
  });

  it('skips a History sheet when there is no history yet', () => {
    const workbook = buildReportWorkbook([{ key: 'g1', guild: GUILD, diff, killTally }]);
    expect(workbook.getWorksheet('Circle of Lore History')).toBeUndefined();
  });

  it('adds a History sheet when past entries are supplied', () => {
    const histories = new Map([
      ['g1', [{ capturedAt: 1, members: 5, atMaxLevel: 1, joined: 0, left: 0, levelUps: 0, promotions: 0, demotions: 0, killsGained: 10 }]]
    ]);

    const workbook = buildReportWorkbook([{ key: 'g1', guild: GUILD, diff, killTally }], { histories });

    expect(readSheet(workbook, 'Circle of Lore History')).toEqual([
      expect.objectContaining({ members: 5, killsGained: 10 })
    ]);
  });

  it('disambiguates sheets for two guilds that share a name', () => {
    const workbook = buildReportWorkbook([
      { key: 'g1', guild: GUILD, diff, killTally },
      { key: 'g2', guild: GUILD, diff, killTally }
    ]);

    expect(workbook.getWorksheet('Circle of Lore Roster')).toBeDefined();
    expect(workbook.getWorksheet('Circle of Lore Roster (2)')).toBeDefined();
  });

  it('defaults a report\'s kill tally to empty when it omits one', () => {
    const workbook = buildReportWorkbook([{ key: 'g1', guild: GUILD, diff }]);
    expect(readSheet(workbook, 'Circle of Lore Kill Tally')).toEqual([]);
  });

  it('falls back to a generic sheet name when a report has no guild', () => {
    const workbook = buildReportWorkbook([{ key: 'g1', guild: null, diff, killTally }]);
    expect(workbook.getWorksheet('Guild Roster')).toBeDefined();
  });

  it('serializes to a real, readable .xlsx buffer', async () => {
    const buffer = await buildReportWorkbookBuffer([{ key: 'g1', guild: GUILD, diff, killTally }]);

    const roundTripped = new ExcelJS.Workbook();
    await roundTripped.xlsx.load(buffer);

    expect(roundTripped.getWorksheet('Circle of Lore Roster')).toBeDefined();
  });
});
