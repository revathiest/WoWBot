// utils/voice/store.js
// "Join to create" voice channel state, on disk.
//
// Two things live here, both keyed differently:
//   - `settings` is per-guild config: which voice channel triggers creation,
//     and which category the private rooms land in.
//   - `active` is one entry per private room currently open, keyed by its own
//     channel id, recording who owns it. This is NOT a cache — it is what
//     lets the handler recognise "this channel is one of ours" and "who
//     leaving should close it" after a restart, when nothing else on the
//     channel itself says so.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'voice.json');

const EMPTY = { settings: {}, active: {} };

let cache = null;

function normalizeId(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const triggerChannelId = normalizeId(source.triggerChannelId);

  // A setup with no trigger channel is not a setup.
  if (!triggerChannelId) return null;

  return {
    triggerChannelId,
    // null means "whatever category the trigger channel itself sits in".
    categoryId: normalizeId(source.categoryId)
  };
}

function normalizeActiveChannel(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const guildId = normalizeId(source.guildId);
  const ownerId = normalizeId(source.ownerId);

  if (!guildId || !ownerId) return null;

  const createdAt = Number(source.createdAt);

  return {
    guildId,
    ownerId,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now()
  };
}

function normalizeStore(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const settings = {};
  for (const [guildId, value] of Object.entries(source.settings ?? {})) {
    const normalized = normalizeSettings(value);
    if (guildId && normalized) settings[guildId] = normalized;
  }

  const active = {};
  for (const [channelId, value] of Object.entries(source.active ?? {})) {
    const normalized = normalizeActiveChannel(value);
    if (channelId && normalized) active[channelId] = normalized;
  }

  return { settings, active };
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

/** Merges into whatever is already configured, like the other admin stores. */
function setSettings(guildId, changes) {
  const store = load();
  const current = store.settings[String(guildId)] ?? {};
  const merged = { ...current, ...changes };

  return save({
    ...store,
    settings: { ...store.settings, [String(guildId)]: merged }
  }).settings[String(guildId)];
}

function clearSettings(guildId) {
  const store = load();
  const settings = { ...store.settings };
  delete settings[String(guildId)];

  save({ ...store, settings });
}

/* ---- active rooms ---- */

function getActiveChannel(channelId) {
  return load().active[String(channelId)] ?? null;
}

function activeChannelsForGuild(guildId) {
  return Object.entries(load().active)
    .filter(([, info]) => info.guildId === String(guildId))
    .map(([channelId, info]) => ({ channelId, ...info }));
}

function addActiveChannel(channelId, { guildId, ownerId, createdAt = Date.now() }) {
  const store = load();

  return save({
    ...store,
    active: { ...store.active, [String(channelId)]: { guildId, ownerId, createdAt } }
  }).active[String(channelId)];
}

function removeActiveChannel(channelId) {
  const store = load();
  const active = { ...store.active };

  if (!active[String(channelId)]) return false;

  delete active[String(channelId)];
  save({ ...store, active });
  return true;
}

function clearCache() {
  cache = null;
}

module.exports = {
  EMPTY,
  STORE_PATH,
  activeChannelsForGuild,
  addActiveChannel,
  clearCache,
  clearSettings,
  getActiveChannel,
  getSettings,
  load,
  normalizeStore,
  removeActiveChannel,
  save,
  setSettings
};
