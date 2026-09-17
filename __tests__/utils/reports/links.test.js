jest.mock('fs');

const fs = require('fs');
const {
  MAX_CHARACTERS_PER_USER,
  buildOwnerIndex,
  characterKey,
  charactersFor,
  clearLinksCache,
  forget,
  linkCharacter,
  loadLinks,
  normalizeLinks,
  unlinkCharacter
} = require('../../../utils/reports/links');

beforeEach(() => {
  jest.clearAllMocks();
  clearLinksCache();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

function fileContains(value) {
  fs.readFileSync.mockReturnValue(typeof value === 'string' ? value : JSON.stringify(value));
}

function fileMissing() {
  const err = new Error('no such file');
  err.code = 'ENOENT';
  fs.readFileSync.mockImplementation(() => {
    throw err;
  });
}

function written() {
  const calls = fs.writeFileSync.mock.calls;
  return JSON.parse(calls[calls.length - 1][1]);
}

const BUTUD = { name: 'Butud', realm: 'Nightslayer', region: 'us', game: 'anniversary' };

describe('characterKey', () => {
  it('matches a typed realm name against a roster slug', () => {
    // This is the whole point: links store names, rosters return slugs.
    expect(characterKey({ name: 'Butud', realm: 'Area 52' })).toBe(
      characterKey({ name: 'butud', realm: 'area-52' })
    );
  });

  it('folds the hyphen Blizzard deletes from realm slugs', () => {
    expect(characterKey({ name: 'X', realm: 'Azjol-Nerub' })).toBe(
      characterKey({ name: 'x', realm: 'azjolnerub' })
    );
  });

  it('keeps different characters apart', () => {
    expect(characterKey({ name: 'Butud', realm: 'Nightslayer' })).not.toBe(
      characterKey({ name: 'Butud', realm: 'Dreamscythe' })
    );
  });
});

describe('normalizeLinks', () => {
  it('drops users left with no usable characters', () => {
    expect(normalizeLinks({ '1': [{ realm: 'Nightslayer' }] })).toEqual({});
  });

  it('survives junk', () => {
    expect(normalizeLinks(null)).toEqual({});
    expect(normalizeLinks({ '1': 'not an array' })).toEqual({});
  });

  it('de-duplicates a character linked twice', () => {
    const links = normalizeLinks({ '1': [BUTUD, { ...BUTUD, name: 'butud' }] });
    expect(links['1']).toHaveLength(1);
  });

  it('caps how many characters one account can hoard', () => {
    const many = Array.from({ length: MAX_CHARACTERS_PER_USER + 5 }, (_, i) => ({
      name: `Alt${i}`,
      realm: 'Nightslayer'
    }));

    expect(normalizeLinks({ '1': many })['1']).toHaveLength(MAX_CHARACTERS_PER_USER);
  });
});

describe('loadLinks', () => {
  it('treats a missing file as nobody having linked anything', () => {
    fileMissing();
    expect(loadLinks()).toEqual({});
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns but carries on when the file is corrupt', () => {
    fs.readFileSync.mockReturnValue('{ broken');
    expect(loadLinks()).toEqual({});
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('linkCharacter', () => {
  it('links a character and writes atomically', () => {
    fileMissing();
    const result = linkCharacter('user-1', BUTUD);

    expect(result.linked).toBe(true);
    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalled();
    expect(written()['user-1']).toEqual([expect.objectContaining({ name: 'Butud' })]);
  });

  it('refuses a character somebody else already claimed, and names them', () => {
    fileContains({ 'user-2': [BUTUD] });

    expect(linkCharacter('user-1', BUTUD)).toMatchObject({
      linked: false,
      reason: 'claimed',
      claimedBy: 'user-2'
    });
  });

  it('lets the same person re-link without complaint about ownership', () => {
    fileContains({ 'user-1': [BUTUD] });
    expect(linkCharacter('user-1', BUTUD)).toMatchObject({ linked: false, reason: 'duplicate' });
  });

  it('refuses once a user hits the character cap', () => {
    fileContains({
      'user-1': Array.from({ length: MAX_CHARACTERS_PER_USER }, (_, i) => ({
        name: `Alt${i}`,
        realm: 'Nightslayer'
      }))
    });

    expect(linkCharacter('user-1', BUTUD)).toMatchObject({ linked: false, reason: 'full' });
  });

  it('moves a claimed character when an admin forces it', () => {
    // An admin assigning a character is usually settling exactly the dispute
    // that a member's own claim would be refused for.
    fileContains({ 'user-2': [BUTUD] });

    const result = linkCharacter('user-1', BUTUD, { force: true });

    expect(result).toMatchObject({ linked: true, movedFrom: 'user-2' });
  });

  it('takes it off the previous holder in the same write', () => {
    fileContains({ 'user-2': [BUTUD, { ...BUTUD, name: 'Other' }] });

    linkCharacter('user-1', BUTUD, { force: true });

    expect(written()['user-2']).toEqual([expect.objectContaining({ name: 'Other' })]);
    expect(written()['user-1']).toEqual([expect.objectContaining({ name: 'Butud' })]);
  });

  it('still refuses a duplicate even when forced', () => {
    fileContains({ 'user-1': [BUTUD] });
    expect(linkCharacter('user-1', BUTUD, { force: true })).toMatchObject({ reason: 'duplicate' });
  });

  it('reports no move when nobody held it', () => {
    fileMissing();
    expect(linkCharacter('user-1', BUTUD, { force: true }).movedFrom).toBeUndefined();
  });

  it('refuses an unusable character', () => {
    fileMissing();
    expect(linkCharacter('user-1', { realm: 'Nightslayer' })).toMatchObject({
      linked: false,
      reason: 'incomplete'
    });
  });
});

describe('unlinkCharacter', () => {
  it('removes one character', () => {
    fileContains({ 'user-1': [BUTUD, { ...BUTUD, name: 'Alt' }] });
    const result = unlinkCharacter('user-1', { name: 'butud' });

    expect(result.removed).toBe(true);
    expect(result.characters).toEqual([expect.objectContaining({ name: 'Alt' })]);
  });

  it('narrows by realm when the same name is linked twice', () => {
    fileContains({ 'user-1': [BUTUD, { ...BUTUD, realm: 'Dreamscythe' }] });
    unlinkCharacter('user-1', { name: 'Butud', realm: 'Dreamscythe' });

    expect(written()['user-1']).toEqual([expect.objectContaining({ realm: 'Nightslayer' })]);
  });

  it('reports a miss without writing', () => {
    fileContains({ 'user-1': [BUTUD] });

    expect(unlinkCharacter('user-1', { name: 'Nobody' }).removed).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('forget', () => {
  it('deletes everything stored for a user', () => {
    fileContains({ 'user-1': [BUTUD], 'user-2': [{ ...BUTUD, name: 'Other' }] });

    expect(forget('user-1')).toEqual({ removed: 1 });
    expect(written()).toEqual({ 'user-2': [expect.objectContaining({ name: 'Other' })] });
  });

  it('is a no-op for a user who never linked anything', () => {
    fileContains({});

    expect(forget('user-1')).toEqual({ removed: 0 });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('charactersFor', () => {
  it('returns an empty list for an unknown user', () => {
    fileContains({});
    expect(charactersFor('nobody')).toEqual([]);
  });
});

describe('buildOwnerIndex', () => {
  it('maps every linked character back to its owner', () => {
    const index = buildOwnerIndex({
      'user-1': [BUTUD],
      'user-2': [{ name: 'Mindbugger', realm: 'Nightslayer' }]
    });

    expect(index.get(characterKey({ name: 'butud', realm: 'nightslayer' }))).toBe('user-1');
    expect(index.get(characterKey({ name: 'Mindbugger', realm: 'Nightslayer' }))).toBe('user-2');
  });

  it('is empty when nobody has linked, which reports must tolerate', () => {
    expect(buildOwnerIndex({}).size).toBe(0);
  });
});
