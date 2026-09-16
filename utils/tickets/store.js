// utils/tickets/store.js
// Ticket state, on disk.
//
// The system this is ported from keeps three MySQL tables — `ticket_settings`,
// `ticket_roles` and `tickets`. This bot has no database, and ticket volume
// does not need one: a community server opens a few tickets a week, of which a
// handful are open at any moment. One JSON file holds all of it.
//
// The only part that grows without bound is closed-ticket history, so it is
// capped and oldest-first — see MAX_CLOSED_HISTORY.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'tickets.json');

/**
 * How many closed tickets to remember.
 *
 * At roughly 300 bytes a record this is well under a megabyte, and years of
 * history for a community server. The alternative — keeping everything — turns
 * a settings file into an ever-growing log with nothing to rotate it.
 */
const MAX_CLOSED_HISTORY = 1000;

// A ticket channel per person, three times over, is already unusual. Beyond
// that it is somebody making a point, and each one is a real channel.
const MAX_OPEN_PER_USER = 3;

const EMPTY = { settings: {}, roles: {}, open: {}, closed: [], nextId: 1 };

let cache = null;

function normalizeId(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value
        .filter(id => id !== null && id !== undefined)
        .map(id => String(id).trim())
        .filter(Boolean)
    )
  ];
}

function normalizeTimestamp(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const channelId = normalizeId(source.channelId);

  // A lobby with no channel is not a lobby.
  if (!channelId) return null;

  return {
    channelId,
    messageId: normalizeId(source.messageId),
    archiveCategoryId: normalizeId(source.archiveCategoryId),
    // Matches the behaviour of the system this came from, which deletes stray
    // chatter in the lobby so the ticket button stays visible.
    policeLobby: source.policeLobby === undefined ? true : Boolean(source.policeLobby)
  };
}

function normalizeTicket(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const id = Number(source.id);

  if (!Number.isFinite(id)) return null;

  return {
    id,
    guildId: normalizeId(source.guildId),
    userId: normalizeId(source.userId),
    channelId: normalizeId(source.channelId),
    claimedBy: normalizeId(source.claimedBy),
    closedBy: normalizeId(source.closedBy),
    controlMessageId: normalizeId(source.controlMessageId),
    description: String(source.description ?? ''),
    createdAt: normalizeTimestamp(source.createdAt),
    closedAt: normalizeTimestamp(source.closedAt)
  };
}

function normalizeStore(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const settings = {};
  for (const [guildId, value] of Object.entries(source.settings ?? {})) {
    const normalized = normalizeSettings(value);
    if (guildId && normalized) settings[guildId] = normalized;
  }

  const roles = {};
  for (const [guildId, value] of Object.entries(source.roles ?? {})) {
    const list = normalizeIdList(value);
    if (guildId && list.length > 0) roles[guildId] = list;
  }

  const open = {};
  for (const [channelId, value] of Object.entries(source.open ?? {})) {
    const ticket = normalizeTicket(value);
    if (channelId && ticket) open[channelId] = { ...ticket, channelId };
  }

  const closed = (Array.isArray(source.closed) ? source.closed : [])
    .map(normalizeTicket)
    .filter(Boolean)
    .slice(-MAX_CLOSED_HISTORY);

  // Ids must never be reused: a recycled id would attach a new ticket's buttons
  // to an old ticket's history.
  const highest = Math.max(
    0,
    ...Object.values(open).map(ticket => ticket.id),
    ...closed.map(ticket => ticket.id)
  );

  const nextId = Math.max(Number(source.nextId) || 1, highest + 1);

  return { settings, roles, open, closed, nextId };
}

function load() {
  if (cache) return cache;

  try {
    cache = normalizeStore(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not read ${STORE_PATH}, starting empty: ${err.message}`);
    }
    cache = normalizeStore(EMPTY);
  }

  return cache;
}

function save(next) {
  const normalized = normalizeStore(next);

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tempPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, STORE_PATH);

  cache = normalized;
  return normalized;
}

/* ---- settings ---- */

function getSettings(guildId) {
  return load().settings[String(guildId)] ?? null;
}

function setSettings(guildId, changes) {
  const store = load();
  const current = store.settings[String(guildId)] ?? {};
  const merged = { ...current, ...changes };

  return save({
    ...store,
    settings: { ...store.settings, [String(guildId)]: merged }
  }).settings[String(guildId)];
}

/* ---- moderator roles ---- */

function getRoles(guildId) {
  return load().roles[String(guildId)] ?? [];
}

function addRole(guildId, roleId) {
  const store = load();
  const current = getRoles(guildId);

  if (current.includes(String(roleId))) return { added: false, roles: current };

  const roles = { ...store.roles, [String(guildId)]: [...current, String(roleId)] };
  return { added: true, roles: save({ ...store, roles }).roles[String(guildId)] };
}

function removeRole(guildId, roleId) {
  const store = load();
  const current = getRoles(guildId);

  if (!current.includes(String(roleId))) return { removed: false, roles: current };

  const remaining = current.filter(id => id !== String(roleId));
  const roles = { ...store.roles };

  if (remaining.length > 0) roles[String(guildId)] = remaining;
  else delete roles[String(guildId)];

  save({ ...store, roles });
  return { removed: true, roles: remaining };
}

/* ---- tickets ---- */

function getOpenByChannel(channelId) {
  return load().open[String(channelId)] ?? null;
}

function getOpenById(ticketId) {
  return Object.values(load().open).find(ticket => ticket.id === Number(ticketId)) ?? null;
}

function openCountFor(guildId, userId) {
  return Object.values(load().open).filter(
    ticket => ticket.guildId === String(guildId) && ticket.userId === String(userId)
  ).length;
}

/** Reserves the next ticket id without creating anything. */
function reserveId() {
  const store = load();
  const id = store.nextId;

  save({ ...store, nextId: id + 1 });
  return id;
}

/**
 * Records a ticket once its channel exists.
 *
 * Deliberately separate from `reserveId`: the id is needed to name the channel,
 * but nothing is stored until the channel is really there. The system this was
 * ported from inserts the row first, so a failure to create the channel leaves
 * a ticket that exists in the database and nowhere else.
 */
function openTicket(ticket) {
  const store = load();
  const record = normalizeTicket({ ...ticket, createdAt: ticket.createdAt ?? Date.now() });

  if (!record || !record.channelId) return null;

  return save({
    ...store,
    open: { ...store.open, [record.channelId]: record }
  }).open[record.channelId];
}

function updateTicket(channelId, changes) {
  const store = load();
  const current = store.open[String(channelId)];

  if (!current) return null;

  return save({
    ...store,
    open: { ...store.open, [String(channelId)]: { ...current, ...changes } }
  }).open[String(channelId)];
}

/** Moves a ticket from open into history. */
function closeTicket(channelId, { closedBy, closedAt = Date.now() } = {}) {
  const store = load();
  const current = store.open[String(channelId)];

  if (!current) return null;

  const closed = { ...current, closedBy: normalizeId(closedBy), closedAt };
  const open = { ...store.open };
  delete open[String(channelId)];

  save({
    ...store,
    open,
    closed: [...store.closed, closed].slice(-MAX_CLOSED_HISTORY)
  });

  return closed;
}

/**
 * Ticket history, newest first. Optionally narrowed to one person.
 * Open tickets are included so a lookup shows the whole picture.
 */
function history({ guildId, userId = null, limit = 10 } = {}) {
  const store = load();

  return [...Object.values(store.open), ...store.closed]
    .filter(ticket => !guildId || ticket.guildId === String(guildId))
    .filter(ticket => !userId || ticket.userId === String(userId))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, limit);
}

function clearCache() {
  cache = null;
}

module.exports = {
  EMPTY,
  MAX_CLOSED_HISTORY,
  MAX_OPEN_PER_USER,
  STORE_PATH,
  addRole,
  clearCache,
  closeTicket,
  getOpenByChannel,
  getOpenById,
  getRoles,
  getSettings,
  history,
  load,
  normalizeStore,
  openCountFor,
  openTicket,
  removeRole,
  reserveId,
  save,
  setSettings,
  updateTicket
};
