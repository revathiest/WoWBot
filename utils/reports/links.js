// utils/reports/links.js
// Which WoW characters belong to which Discord member.
//
// This is the first user data the bot has ever stored, and it exists for one
// reason: a weekly report reads far better when it can say "@Ken hit 70" rather
// than "Butud hit 70". It is therefore deliberately minimal — a Discord user id
// and the character names that person volunteered, nothing else. No display
// names, no join dates, no activity. `forget` deletes everything for a user in
// one call, and is the reason the file stays a plain map keyed by user id.
//
// Linking is entirely optional. Reports are built from guild rosters and work
// with this file empty; a link only upgrades a character name into a mention.

const fs = require('fs');
const path = require('path');

const { normalizeGame, normalizeRegion, readConfig } = require('../../config');
const { realmMatchKey } = require('../wow');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LINKS_PATH = path.join(DATA_DIR, 'links.json');

// Enough for an altoholic, low enough that one account cannot bloat the file.
const MAX_CHARACTERS_PER_USER = 20;

let cache = null;

/**
 * How a character is matched between the link file and a guild roster.
 *
 * Rosters identify a realm by slug and links store whatever realm name the user
 * typed, so both go through `realmMatchKey`, which folds accents and drops
 * separators. "Area 52" and "area-52" collapse to the same key.
 */
function characterKey({ name, realm }) {
  return `${realmMatchKey(realm)}:${String(name ?? '').trim().toLowerCase()}`;
}

function normalizeCharacter(raw, config = readConfig()) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const name = String(source.name ?? '').trim();
  const realm = String(source.realm ?? '').trim() || config.blizzard.realm;

  if (!name || !realm) return null;

  return {
    name,
    realm,
    region: normalizeRegion(source.region) ?? config.blizzard.region,
    game: normalizeGame(source.game) ?? config.blizzard.game
  };
}

function normalizeCharacters(value, config = readConfig()) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const characters = [];

  for (const raw of value) {
    const character = normalizeCharacter(raw, config);
    if (!character) continue;

    const key = characterKey(character);
    if (seen.has(key)) continue;

    seen.add(key);
    characters.push(character);

    if (characters.length >= MAX_CHARACTERS_PER_USER) break;
  }

  return characters;
}

/** Applies defaults and drops anything unusable, as the spam config does. */
function normalizeLinks(raw = {}, config = readConfig()) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const links = {};

  for (const [userId, characters] of Object.entries(source)) {
    const id = String(userId ?? '').trim();
    if (!id) continue;

    const normalized = normalizeCharacters(characters, config);
    if (normalized.length > 0) links[id] = normalized;
  }

  return links;
}

function loadLinks() {
  if (cache) return cache;

  try {
    cache = normalizeLinks(JSON.parse(fs.readFileSync(LINKS_PATH, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️  Could not read ${LINKS_PATH}, treating it as empty: ${err.message}`);
    }
    cache = {};
  }

  return cache;
}

function saveLinks(links) {
  const next = normalizeLinks(links);

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tempPath = `${LINKS_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, LINKS_PATH);

  cache = next;
  return next;
}

/** Characters a member has linked. */
function charactersFor(userId) {
  return loadLinks()[String(userId ?? '').trim()] ?? [];
}

/**
 * Links a character to a member.
 *
 * `force` is what separates a member claiming their own character from an
 * admin assigning one. A member is refused if somebody else already holds it —
 * two people cannot both be Butud-Nightslayer, and silently stealing it would
 * be worse. An admin is resolving exactly that kind of dispute, so their
 * assignment moves the character and reports who lost it.
 *
 * @returns {{linked: boolean, reason: string|null, characters: object[], movedFrom?: string}}
 */
function linkCharacter(userId, raw, { force = false } = {}) {
  const id = String(userId ?? '').trim();
  const character = normalizeCharacter(raw);

  if (!id || !character) {
    return { linked: false, reason: 'incomplete', characters: charactersFor(id) };
  }

  const links = loadLinks();
  const existing = links[id] ?? [];
  const key = characterKey(character);

  const owner = Object.entries(links).find(
    ([ownerId, characters]) =>
      ownerId !== id && characters.some(entry => characterKey(entry) === key)
  );

  if (owner && !force) {
    return { linked: false, reason: 'claimed', claimedBy: owner[0], characters: existing };
  }

  if (existing.some(entry => characterKey(entry) === key)) {
    return { linked: false, reason: 'duplicate', characters: existing };
  }

  if (existing.length >= MAX_CHARACTERS_PER_USER) {
    return { linked: false, reason: 'full', characters: existing };
  }

  const updated = { ...links, [id]: [...existing, character] };

  // Taking it off the previous holder in the same write, so the character is
  // never briefly linked to two people.
  if (owner) {
    updated[owner[0]] = owner[1].filter(entry => characterKey(entry) !== key);
  }

  const next = saveLinks(updated);

  return {
    linked: true,
    reason: null,
    characters: next[id],
    ...(owner ? { movedFrom: owner[0] } : {})
  };
}

/** Unlinks one character. Realm narrows the match when names collide. */
function unlinkCharacter(userId, { name, realm = null }) {
  const id = String(userId ?? '').trim();
  const links = loadLinks();
  const existing = links[id] ?? [];

  const nameKey = String(name ?? '').trim().toLowerCase();
  const realmKey = realm ? realmMatchKey(realm) : null;

  const remaining = existing.filter(
    entry =>
      entry.name.toLowerCase() !== nameKey ||
      (realmKey !== null && realmMatchKey(entry.realm) !== realmKey)
  );

  if (remaining.length === existing.length) {
    return { removed: false, characters: existing };
  }

  const next = saveLinks({ ...links, [id]: remaining });
  return { removed: true, characters: next[id] ?? [] };
}

/** Deletes everything stored for a member. */
function forget(userId) {
  const id = String(userId ?? '').trim();
  const links = loadLinks();

  if (!links[id]) return { removed: 0 };

  const removed = links[id].length;
  const next = { ...links };
  delete next[id];

  saveLinks(next);
  return { removed };
}

/**
 * Character key -> Discord user id, for turning roster names into mentions.
 * Built once per report rather than scanned per member.
 */
function buildOwnerIndex(links = loadLinks()) {
  const index = new Map();

  for (const [userId, characters] of Object.entries(links)) {
    for (const character of characters) {
      index.set(characterKey(character), userId);
    }
  }

  return index;
}

function clearLinksCache() {
  cache = null;
}

module.exports = {
  DATA_DIR,
  LINKS_PATH,
  MAX_CHARACTERS_PER_USER,
  buildOwnerIndex,
  characterKey,
  charactersFor,
  clearLinksCache,
  forget,
  linkCharacter,
  loadLinks,
  normalizeLinks,
  saveLinks,
  unlinkCharacter
};
