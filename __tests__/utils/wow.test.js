const wow = require('../../utils/wow');

describe('slugifyRealm', () => {
  // Every expectation below is a real name -> real slug pair taken from the live
  // realm index. The rule was validated against all 801 realms in us/eu/kr/tw.
  it.each([
    // Only spaces become hyphens.
    ['Area 52', 'area-52'],
    ['Conseil des Ombres', 'conseil-des-ombres'],
    ['  Burning Blade  ', 'burning-blade'],
    // Apostrophes and hyphens are DELETED, not turned into separators.
    ['Mal’Ganis', 'malganis'],
    ["Kil'jaeden", 'kiljaeden'],
    ['Azjol-Nerub', 'azjolnerub'],
    ['Arak-arahm', 'arakarahm'],
    ["Lightning's Blade", 'lightnings-blade'],
    ['zzz_RDB EU', 'zzzrdb-eu'],
    // Accents are PRESERVED, not folded to ASCII.
    ['Festung der Stürme', 'festung-der-stürme'],
    ['Marécage de Zangar', 'marécage-de-zangar'],
    ['La Croisade écarlate', 'la-croisade-écarlate'],
    ['Aggra (Português)', 'aggra-português']
  ])('turns %s into %s', (input, expected) => {
    expect(wow.slugifyRealm(input)).toBe(expected);
  });

  it('handles empty input without throwing', () => {
    expect(wow.slugifyRealm(undefined)).toBe('');
    expect(wow.slugifyRealm('')).toBe('');
  });
});

describe('realmMatchKey', () => {
  it('collapses the ways a person might type one realm', () => {
    const expected = wow.realmMatchKey('Azjol-Nerub');

    ['azjol nerub', 'AZJOLNERUB', 'azjol-nerub', "Azjol'Nerub"].forEach(variant => {
      expect(wow.realmMatchKey(variant)).toBe(expected);
    });
  });

  it('folds accents so ASCII input still matches', () => {
    expect(wow.realmMatchKey('Marécage de Zangar')).toBe(wow.realmMatchKey('Marecage de Zangar'));
  });

  it('is empty for empty input', () => {
    expect(wow.realmMatchKey(undefined)).toBe('');
  });
});

describe('encodeCharacterName', () => {
  it('lowercases names because Blizzard paths require it', () => {
    expect(wow.encodeCharacterName('Thrall')).toBe('thrall');
  });

  it('percent-encodes accented names', () => {
    expect(wow.encodeCharacterName('Sylvänas')).toBe('sylv%C3%A4nas');
  });
});

describe('localized', () => {
  it('flattens the localized maps returned by search endpoints', () => {
    expect(wow.localized({ en_US: 'Thunderfury', de_DE: 'Donnerzorn' })).toBe('Thunderfury');
  });

  it('honours a requested locale, then falls back', () => {
    expect(wow.localized({ en_US: 'Thunderfury', de_DE: 'Donnerzorn' }, 'de_DE')).toBe('Donnerzorn');
    expect(wow.localized({ fr_FR: 'Fureur' }, 'de_DE')).toBe('Fureur');
  });

  it('passes plain strings through and maps nullish to null', () => {
    expect(wow.localized('Plain')).toBe('Plain');
    expect(wow.localized(null)).toBeNull();
    expect(wow.localized(undefined)).toBeNull();
  });
});

describe('colour helpers', () => {
  it('matches class colours case-insensitively', () => {
    expect(wow.classColor('Death Knight')).toBe(0xc41e3a);
    expect(wow.classColor('druid')).toBe(0xff7c0a);
  });

  it('falls back for unknown classes, qualities, and factions', () => {
    expect(wow.classColor('Tinker')).toBe(wow.FALLBACK_COLOR);
    expect(wow.qualityColor(undefined)).toBe(wow.FALLBACK_COLOR);
    expect(wow.factionColor('Neutral')).toBe(wow.FALLBACK_COLOR);
  });

  it('maps item qualities and factions', () => {
    expect(wow.qualityColor('EPIC')).toBe(0xa335ee);
    expect(wow.factionColor('Horde')).toBe(0xb30000);
  });
});

describe('formatGold', () => {
  it('converts copper to gold, dropping empty units', () => {
    expect(wow.formatGold(2000000000)).toBe('200,000g');
    expect(wow.formatGold(12345)).toBe('1g 23s 45c');
    expect(wow.formatGold(500)).toBe('5s');
  });

  it('shows zero copper rather than an empty string', () => {
    expect(wow.formatGold(0)).toBe('0c');
    expect(wow.formatGold(undefined)).toBe('0c');
  });

  it('clamps negative values', () => {
    expect(wow.formatGold(-100)).toBe('0c');
  });
});

describe('formatNumber', () => {
  it('groups thousands', () => {
    expect(wow.formatNumber(1234567)).toBe('1,234,567');
  });

  it('returns a dash for values that are not numbers', () => {
    expect(wow.formatNumber(undefined)).toBe('—');
    expect(wow.formatNumber('abc')).toBe('—');
  });
});

describe('formatDuration', () => {
  it('renders milliseconds as m:ss', () => {
    expect(wow.formatDuration(1834000)).toBe('30:34');
    expect(wow.formatDuration(65000)).toBe('1:05');
    expect(wow.formatDuration(0)).toBe('0:00');
  });
});

describe('discordTimestamp', () => {
  it('emits a relative timestamp tag', () => {
    expect(wow.discordTimestamp(1700000000000)).toBe('<t:1700000000:R>');
  });

  it('accepts an explicit style', () => {
    expect(wow.discordTimestamp(1700000000000, 'F')).toBe('<t:1700000000:F>');
  });

  it('returns null for missing or invalid timestamps', () => {
    expect(wow.discordTimestamp(0)).toBeNull();
    expect(wow.discordTimestamp(undefined)).toBeNull();
  });
});

describe('wowheadItemUrl', () => {
  // There is only one database now: Classic Forever is patch 1.60.1, so the
  // vanilla path is always correct. Checked against a real item.
  it('always links to the classic database', () => {
    expect(wow.wowheadItemUrl(19019)).toBe('https://www.wowhead.com/classic/item=19019');
    expect(wow.wowheadItemUrl(1)).toBe('https://www.wowhead.com/classic/item=1');
  });
});

describe('mediaAsset', () => {
  const media = {
    assets: [
      { key: 'avatar', value: 'https://render/avatar.jpg' },
      { key: 'main-raw', value: 'https://render/main.png' }
    ]
  };

  it('finds an asset by key', () => {
    expect(wow.mediaAsset(media, 'avatar')).toBe('https://render/avatar.jpg');
    expect(wow.mediaAsset(media, 'main-raw')).toBe('https://render/main.png');
  });

  it('returns null when the key is absent', () => {
    expect(wow.mediaAsset(media, 'inset')).toBeNull();
    expect(wow.mediaAsset(null, 'avatar')).toBeNull();
  });

  it('falls back to the legacy avatar_url field', () => {
    expect(wow.mediaAsset({ avatar_url: 'https://legacy/a.jpg' }, 'avatar')).toBe(
      'https://legacy/a.jpg'
    );
  });
});

describe('titleCase', () => {
  it('normalises casing across spaces and hyphens', () => {
    expect(wow.titleCase('BURNING blade')).toBe('Burning Blade');
    expect(wow.titleCase('azjol-nerub')).toBe('Azjol Nerub');
    expect(wow.titleCase('')).toBe('');
  });
});

describe('REGION_CHOICES', () => {
  it('offers each supported region as an uppercase choice', () => {
    expect(wow.REGION_CHOICES).toEqual([
      { name: 'US', value: 'us' },
      { name: 'EU', value: 'eu' },
      { name: 'KR', value: 'kr' },
      { name: 'TW', value: 'tw' }
    ]);
  });
});

describe('characterSlug', () => {
  it('builds the realmless Classic Forever address', () => {
    expect(wow.characterSlug('Judgement', 'Judy')).toBe('judgement-judy');
  });

  it('keeps accents, because Blizzard does', () => {
    expect(wow.characterSlug('Élodie', 'Stürm')).toBe('élodie-stürm');
  });

  it('strips punctuation inside each half, so the hyphen stays the only separator', () => {
    expect(wow.characterSlug("Mal'Ganis", 'Van-Cleef')).toBe('malganis-vancleef');
  });

  it('returns null without a surname, rather than a half address', () => {
    // A Forever character has no realm, so the surname is what makes the name
    // unique. A one-word address could never match.
    expect(wow.characterSlug('Judgement', '')).toBeNull();
    expect(wow.characterSlug('Judgement', null)).toBeNull();
    expect(wow.characterSlug('', 'Judy')).toBeNull();
  });
});

describe('splitCharacterName', () => {
  it('splits every shape people actually type', () => {
    expect(wow.splitCharacterName('Judgement-Judy')).toEqual({
      name: 'Judgement',
      surname: 'Judy'
    });
    expect(wow.splitCharacterName('Judgement Judy')).toEqual({
      name: 'Judgement',
      surname: 'Judy'
    });
  });

  it('reports a missing surname as null so the caller can ask for one', () => {
    expect(wow.splitCharacterName('Judgement')).toEqual({ name: 'Judgement', surname: null });
    expect(wow.splitCharacterName('')).toEqual({ name: null, surname: null });
  });

  it('does not split on letters that merely look like escapes', () => {
    // Guards a real bug: a damaged character class once split on the letter "s".
    expect(wow.splitCharacterName('Sassy Smith')).toEqual({ name: 'Sassy', surname: 'Smith' });
  });

  it('folds anything past the second word into the surname', () => {
    expect(wow.splitCharacterName('Judgement Judy Smith')).toEqual({
      name: 'Judgement',
      surname: 'Judy Smith'
    });
  });
});

describe('fullCharacterName', () => {
  it('joins name and surname', () => {
    expect(wow.fullCharacterName({ name: 'Judgement', surname: 'Judy' })).toBe('Judgement Judy');
  });

  it('drops a missing surname instead of leaving a trailing space', () => {
    expect(wow.fullCharacterName({ name: 'Judgement' })).toBe('Judgement');
    expect(wow.fullCharacterName({ name: 'Judgement', surname: null })).toBe('Judgement');
  });

  it('trims each half before joining, so stray whitespace cannot double up', () => {
    expect(wow.fullCharacterName({ name: 'Judgement ', surname: ' Judy' })).toBe('Judgement Judy');
  });

  it('is empty, not null, when there is nothing to show', () => {
    expect(wow.fullCharacterName({})).toBe('');
    expect(wow.fullCharacterName(null)).toBe('');
  });
});

