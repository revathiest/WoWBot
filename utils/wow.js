// utils/wow.js
// Presentation helpers: slugs, colours, and the formatting shared by the WoW commands.

const { REGIONS } = require('../config');

// Official class colours, used to tint character embeds.
const CLASS_COLORS = {
  'death knight': 0xc41e3a,
  'demon hunter': 0xa330c9,
  druid: 0xff7c0a,
  evoker: 0x33937f,
  hunter: 0xaad372,
  mage: 0x3fc7eb,
  monk: 0x00ff98,
  paladin: 0xf48cba,
  priest: 0xffffff,
  rogue: 0xfff468,
  shaman: 0x0070dd,
  warlock: 0x8788ee,
  warrior: 0xc69b6d
};

const QUALITY_COLORS = {
  poor: 0x9d9d9d,
  common: 0xffffff,
  uncommon: 0x1eff00,
  rare: 0x0070dd,
  epic: 0xa335ee,
  legendary: 0xff8000,
  artifact: 0xe6cc80,
  heirloom: 0x00ccff
};

const FACTION_COLORS = {
  alliance: 0x0078ff,
  horde: 0xb30000
};

const FALLBACK_COLOR = 0x5865f2;

// Slash-command choices for the shared `region` option.
const REGION_CHOICES = REGIONS.map(region => ({ name: region.toUpperCase(), value: region }));

function stripDiacritics(value) {
  // Decompose, then drop the combining marks so "Éonar" becomes "Eonar".
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Converts a realm name to the slug Blizzard expects in profile URLs.
 * "Area 52" -> "area-52", "Mal'Ganis" -> "malganis", "Azjol-Nerub" -> "azjol-nerub".
 */
function slugifyRealm(realm) {
  return stripDiacritics(String(realm ?? ''))
    .toLowerCase()
    .replace(/['’]/g, '') // apostrophes vanish rather than becoming separators
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Character names are lowercased in the path; encode so accented names survive.
function encodeCharacterName(name) {
  return encodeURIComponent(String(name ?? '').trim().toLowerCase());
}

function titleCase(value) {
  return String(value ?? '')
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Search results return localized maps ({ en_US: "..." }) while direct document
 * fetches return plain strings. This flattens either shape.
 */
function localized(value, locale = 'en_US') {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return value[locale] ?? value.en_US ?? Object.values(value)[0] ?? null;
  }
  return String(value);
}

function classColor(className) {
  return CLASS_COLORS[String(className ?? '').toLowerCase()] ?? FALLBACK_COLOR;
}

function qualityColor(qualityName) {
  return QUALITY_COLORS[String(qualityName ?? '').toLowerCase()] ?? FALLBACK_COLOR;
}

function factionColor(factionName) {
  return FACTION_COLORS[String(factionName ?? '').toLowerCase()] ?? FALLBACK_COLOR;
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-US') : '—';
}

/**
 * Blizzard reports currency in copper. 100 copper = 1 silver, 100 silver = 1 gold.
 * Zero-valued trailing units are dropped, so a round price reads "375,000g".
 */
function formatGold(copperValue) {
  const total = Math.max(Math.trunc(Number(copperValue) || 0), 0);

  const gold = Math.floor(total / 10000);
  const silver = Math.floor((total % 10000) / 100);
  const copper = total % 100;

  const parts = [];
  if (gold) parts.push(`${formatNumber(gold)}g`);
  if (silver) parts.push(`${silver}s`);
  if (copper || parts.length === 0) parts.push(`${copper}c`);

  return parts.join(' ');
}

// Discord renders these as localised, self-updating timestamps.
function discordTimestamp(msSinceEpoch, style = 'R') {
  const ms = Number(msSinceEpoch);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

// Mythic+ run durations arrive in milliseconds.
function formatDuration(ms) {
  const total = Math.max(Math.trunc(Number(ms) || 0), 0);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Builds the armory URL for a character. Region subdomains differ from API regions
 * only in that the Americas armory lives under /en-us.
 */
function armoryUrl({ region, realmSlug, characterName }) {
  const localePath = { us: 'en-us', eu: 'en-gb', kr: 'ko-kr', tw: 'zh-tw' }[region] ?? 'en-us';
  return `https://worldofwarcraft.blizzard.com/${localePath}/character/${region}/${realmSlug}/${encodeCharacterName(characterName)}`;
}

/** Pulls a named asset (avatar, inset, main-raw) out of a character-media payload. */
function mediaAsset(media, key) {
  const assets = media?.assets;

  if (Array.isArray(assets)) {
    const match = assets.find(asset => asset?.key === key);
    if (match?.value) return match.value;
  }

  // Older payloads exposed the avatar directly.
  if (key === 'avatar' && media?.avatar_url) return media.avatar_url;

  return null;
}

/** Connected-realm references are hrefs; the id is the last path segment. */
function idFromHref(href) {
  const match = /\/(\d+)(?:\?|$)/.exec(String(href ?? ''));
  return match ? Number(match[1]) : null;
}

module.exports = {
  CLASS_COLORS,
  QUALITY_COLORS,
  FACTION_COLORS,
  FALLBACK_COLOR,
  REGION_CHOICES,
  armoryUrl,
  classColor,
  discordTimestamp,
  encodeCharacterName,
  factionColor,
  formatDuration,
  formatGold,
  formatNumber,
  idFromHref,
  localized,
  mediaAsset,
  qualityColor,
  slugifyRealm,
  stripDiacritics,
  titleCase
};
