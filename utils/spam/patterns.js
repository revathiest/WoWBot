// utils/spam/patterns.js
// Scam-wording patterns, grouped by category. Pure data plus one matcher — no
// imports, no Discord types.
//
// Patterns are deliberately context-bound rather than keyword-bound. A bare
// /airdrop/i would flag "the enemy did an airdrop on our position", which is
// ordinary WoW/Star Citizen chat. Every category below has a negative test.

const SPAM_PATTERNS = {
  'crypto/NFT scam': [
    /\bfree\s+(nfts?|crypto|bitcoin|btc|ethereum|eth|usdt|bnb|sol|tokens?)\b/i,
    /\bclaim\s+(your\s+)?(free\s+)?(tokens?|nfts?|crypto|airdrop|reward|prize)\b/i,
    // Only an airdrop in crypto company counts.
    /\bairdrop\b.{0,40}(wallet|token|crypto|claim)/is,
    /\b0x[a-fA-F0-9]{40}\b/ // raw ETH address
  ],

  'URL shortener': [
    /https?:\/\/(bit\.ly|tinyurl\.com|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|short\.io|cutt\.ly|t\.co)\//i
  ],

  'server promotion': [
    /\bjoin\s+(my|our)\s+(server|discord|community)\b/i,
    /\binvite\s+(link|code)\s*(for|to)\b/i
  ],

  'Nitro/gift card scam': [
    /\bfree\s+nitro\b/i,
    /\bnitro\s+(giveaway|gift)\b/i,
    /\bfree\s+(gift\s*card|robux|v-?bucks)\b/i,
    /\bsteam\s+gift\s*card\b/i
  ],

  'get-rich-quick': [
    /\bearn\s+\$?\d+\s*(\/\s*|\s+per\s+)(day|hour|week|month)\b/i,
    // Three digits or more, so "earn $5 a day" in conversation does not fire.
    /\bmake\s+\$?\d{3,}\s*(\/\s*|\s+per\s+)(day|hour|week)\b/i
  ]
};

const INVITE_PATTERN = /discord(?:\.gg|app\.com\/invite|\.com\/invite)\/[a-zA-Z0-9-]+/i;

/**
 * Returns the names of every category the text matches. One message can match
 * several categories, and each counts as its own red flag.
 */
function matchPatterns(content) {
  const text = String(content ?? '');
  if (!text) return [];

  return Object.entries(SPAM_PATTERNS)
    .filter(([, patterns]) => patterns.some(pattern => pattern.test(text)))
    .map(([category]) => category);
}

/** True when the text contains a Discord invite link. */
function hasInviteLink(content) {
  return INVITE_PATTERN.test(String(content ?? ''));
}

module.exports = {
  INVITE_PATTERN,
  SPAM_PATTERNS,
  hasInviteLink,
  matchPatterns
};
