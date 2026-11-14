// utils/reports/excel.js
// The weekly guild report, as a downloadable .xlsx workbook.
//
// Discord's embeds are built for reading in the client, not for sorting,
// filtering, or keeping around after the channel's history scrolls past. This
// turns the same data render.js turns into embeds — a diff per guild, plus its
// kill tally — into plain rows instead, one workbook per `/report excel`
// request. Nothing here touches Discord.js; it only takes the plain objects
// `buildAllReports` already produces.

const ExcelJS = require('exceljs');

const { characterKey } = require('./links');
const { fullCharacterName } = require('../wow');

// Excel's own limit. Longer, and the file simply fails to open.
const MAX_SHEET_NAME = 31;

/** Strips the characters Excel forbids in a sheet name, and caps the length. */
function sheetName(label) {
  const cleaned = String(label).replace(/[*?:/\\[\]]/g, ' ').trim();
  return cleaned.slice(0, MAX_SHEET_NAME) || 'Sheet';
}

/**
 * Disambiguates sheet names when two tracked guilds share one — same name,
 * different region — rather than letting the second overwrite the first.
 */
function uniqueSheetName(used, label) {
  const base = sheetName(label);
  let name = base;
  let suffix = 2;

  while (used.has(name)) {
    const tail = ` (${suffix})`;
    name = `${base.slice(0, MAX_SHEET_NAME - tail.length)}${tail}`;
    suffix += 1;
  }

  used.add(name);
  return name;
}

function addSheet(workbook, used, guildName, kind, columns) {
  const sheet = workbook.addWorksheet(uniqueSheetName(used, `${guildName} ${kind}`));
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  return sheet;
}

/**
 * Who, if anyone, has claimed a character — as a Discord tag when one is
 * resolvable, otherwise the bare id, otherwise blank. Mention syntax
 * (`<@id>`) only renders inside Discord, so it has no place in a file meant
 * to be opened outside it.
 */
function linkedTo(entry, owners, resolveTag) {
  const userId = owners?.get?.(characterKey({ name: entry.name, surname: entry.surname }));
  if (!userId) return '';

  return resolveTag?.(userId) ?? userId;
}

function rosterRows(diff, killsByKey, owners, resolveTag) {
  return (diff.members ?? []).map(member => ({
    character: fullCharacterName(member),
    className: member.className ?? '',
    level: member.level ?? '',
    lifetimeKills: killsByKey.get(characterKey(member)) ?? '',
    linked: linkedTo(member, owners, resolveTag)
  }));
}

/** One row per membership/level/rank change, with a `type` column distinguishing them. */
function changeRows(diff) {
  const rows = [];

  for (const entry of diff.joined) {
    rows.push({ type: 'Joined', character: fullCharacterName(entry), className: entry.className ?? '', level: entry.level ?? '', detail: '' });
  }

  for (const entry of diff.left) {
    rows.push({ type: 'Left', character: fullCharacterName(entry), className: entry.className ?? '', level: entry.level ?? '', detail: '' });
  }

  for (const entry of diff.levelUps) {
    rows.push({
      type: 'Level up',
      character: fullCharacterName(entry),
      className: entry.className ?? '',
      level: entry.to ?? '',
      detail: `${entry.from} → ${entry.to}${entry.cappedOut ? ' (hit the cap)' : ''}`
    });
  }

  for (const entry of diff.promotions) {
    rows.push({
      type: 'Promotion',
      character: fullCharacterName(entry),
      className: entry.className ?? '',
      level: entry.level ?? '',
      detail: `rank ${entry.from} → ${entry.to}`
    });
  }

  for (const entry of diff.kills) {
    rows.push({
      type: 'Honorable kills',
      character: fullCharacterName(entry),
      className: entry.className ?? '',
      level: '',
      detail: `+${entry.change} (${entry.total} total)`
    });
  }

  return rows;
}

function killTallyRows(tally) {
  return tally.map(entry => ({
    character: fullCharacterName(entry),
    className: entry.className ?? '',
    today: entry.today ?? '',
    last7: entry.last7 ?? '',
    lifetime: entry.lifetime
  }));
}

/** One row per past report, oldest first — the trend a chart would show, as numbers. */
function historyRows(entries) {
  return entries.map(entry => ({
    date: new Date(entry.capturedAt),
    members: entry.members,
    atMaxLevel: entry.atMaxLevel,
    joined: entry.joined,
    left: entry.left,
    levelUps: entry.levelUps,
    promotions: entry.promotions,
    demotions: entry.demotions,
    killsGained: entry.killsGained
  }));
}

/**
 * Builds the workbook: four sheets per guild (Roster, Changes, Kill Tally,
 * and History).
 *
 * @param {object[]} reports  From `buildAllReports` — `{ key, guild, diff, killTally }`.
 * @param {Map} owners  Character key -> Discord user id, from `buildOwnerIndex`.
 * @param {(userId: string) => string|null} resolveTag  Looks up a Discord tag
 *   for a user id; omit to leave the bare id in the sheet.
 * @param {Map} histories  Guild key -> that guild's `loadReportHistory()`
 *   entries. Passed in rather than read here so this module stays a pure
 *   function of its arguments, like render.js. Omit (or leave a guild out) to
 *   skip that guild's History sheet — there is nothing to show on a first run.
 */
function buildReportWorkbook(reports, { owners = new Map(), resolveTag = null, histories = new Map() } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();

  const used = new Set();

  for (const { key, guild, diff, killTally = [] } of reports) {
    const guildName = guild?.name ?? 'Guild';
    const killsByKey = new Map(killTally.map(entry => [characterKey(entry), entry.lifetime]));

    const roster = addSheet(workbook, used, guildName, 'Roster', [
      { header: 'Character', key: 'character', width: 24 },
      { header: 'Class', key: 'className', width: 16 },
      { header: 'Level', key: 'level', width: 8 },
      { header: 'Lifetime Kills', key: 'lifetimeKills', width: 14 },
      { header: 'Linked Discord User', key: 'linked', width: 22 }
    ]);
    roster.addRows(rosterRows(diff, killsByKey, owners, resolveTag));

    const changes = addSheet(workbook, used, guildName, 'Changes', [
      { header: 'Type', key: 'type', width: 16 },
      { header: 'Character', key: 'character', width: 24 },
      { header: 'Class', key: 'className', width: 16 },
      { header: 'Level', key: 'level', width: 8 },
      { header: 'Detail', key: 'detail', width: 28 }
    ]);
    changes.addRows(changeRows(diff));

    const kills = addSheet(workbook, used, guildName, 'Kill Tally', [
      { header: 'Character', key: 'character', width: 24 },
      { header: 'Class', key: 'className', width: 16 },
      { header: 'Today', key: 'today', width: 10 },
      { header: 'Last 7 Days', key: 'last7', width: 12 },
      { header: 'Lifetime', key: 'lifetime', width: 12 }
    ]);
    kills.addRows(killTallyRows(killTally));

    const entries = histories.get?.(key) ?? [];
    if (entries.length > 0) {
      const history = addSheet(workbook, used, guildName, 'History', [
        { header: 'Date', key: 'date', width: 20 },
        { header: 'Members', key: 'members', width: 10 },
        { header: 'At Max Level', key: 'atMaxLevel', width: 14 },
        { header: 'Joined', key: 'joined', width: 10 },
        { header: 'Left', key: 'left', width: 10 },
        { header: 'Level-ups', key: 'levelUps', width: 12 },
        { header: 'Promotions', key: 'promotions', width: 12 },
        { header: 'Demotions', key: 'demotions', width: 12 },
        { header: 'Kills Gained', key: 'killsGained', width: 14 }
      ]);
      history.getColumn('date').numFmt = 'yyyy-mm-dd hh:mm';
      history.addRows(historyRows(entries));
    }
  }

  return workbook;
}

/** The workbook, serialized — what actually gets attached to a Discord message. */
async function buildReportWorkbookBuffer(reports, options = {}) {
  const workbook = buildReportWorkbook(reports, options);
  return workbook.xlsx.writeBuffer();
}

module.exports = {
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
};
