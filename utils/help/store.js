// utils/help/store.js
// Where the help post lives, per guild.
//
// The channel it was posted in, and the ids of the messages that make it up, in
// order. The post spans several messages (one per category), so this is a list:
// it lets each message be edited in place on restart rather than a fresh copy
// of the whole post being appended every time the bot starts.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'help.json');

let cache = null;

function normalizeId(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeId).filter(Boolean);
}

function normalizeStore(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const guilds = {};

  for (const [guildId, value] of Object.entries(source)) {
    const channelId = normalizeId(value?.channelId);

    // No channel means no post; the entry is meaningless without one.
    if (!guildId || !channelId) continue;

    guilds[guildId] = {
      channelId,
      messageIds: normalizeIdList(value?.messageIds),
      // What the post looked like last time, so a restart can tell whether
      // anything actually changed.
      fingerprint: normalizeId(value?.fingerprint)
    };
  }

  return guilds;
}

function load() {
  if (cache) return cache;

  try {
    cache = normalizeStore(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not read ${STORE_PATH}, starting empty: ${err.message}`);
    }
    cache = {};
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

function get(guildId) {
  return load()[String(guildId)] ?? null;
}

function set(guildId, changes) {
  const store = load();
  const merged = { ...(store[String(guildId)] ?? {}), ...changes };

  return save({ ...store, [String(guildId)]: merged })[String(guildId)] ?? null;
}

function clear(guildId) {
  const store = load();
  if (!store[String(guildId)]) return false;

  const next = { ...store };
  delete next[String(guildId)];
  save(next);

  return true;
}

function guildIds() {
  return Object.keys(load());
}

function clearCache() {
  cache = null;
}

module.exports = {
  STORE_PATH,
  clear,
  clearCache,
  get,
  guildIds,
  load,
  normalizeStore,
  save,
  set
};
