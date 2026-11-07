jest.mock('fs');

const fs = require('fs');
const {
  MAX_CHARACTERS_PER_USER,
  mainFor,
  setMain,
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

// Characters have no realm. The surname is what keeps two same-named
// characters apart, so it is required alongside the name.
const JUDY = { name: 'Judgement', surname: 'Judy', region: 'eu' };

describe('characterKey', () => {
  it('matches regardless of casing', () => {
    expect(characterKey({ name: 'Judgement', surname: 'Judy' })).toBe(
      characterKey({ name: 'judgement', surname: 'judy' })
    );
  });

  it('keeps two characters with the same first name apart', () => {
    // This is the whole point: without the surname, two unrelated characters
    // would collapse into one link.
    expect(characterKey({ name: 'Judgement', surname: 'Judy' })).not.toBe(
      characterKey({ name: 'Judgement', surname: 'Smith' })
    );
  });
});

describe('normalizeLinks', () => {
  it('drops users left with no usable characters', () => {
    expect(normalizeLinks({ '1': [{ name: 'Judgement' }] })).toEqual({});
  });

  it('survives junk', () => {
    expect(normalizeLinks(null)).toEqual({});
    expect(normalizeLinks({ '1': 'not an array' })).toEqual({});
  });

  it('de-duplicates a character linked twice', () => {
    const links = normalizeLinks({ '1': [JUDY, { ...JUDY, name: 'judgement' }] });
    expect(links['1']).toHaveLength(1);
  });

  it('caps how many characters one account can hoard', () => {
    const many = Array.from({ length: MAX_CHARACTERS_PER_USER + 5 }, (_, i) => ({
      name: `Alt${i}`,
      surname: 'Smith'
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
    const result = linkCharacter('user-1', JUDY);

    expect(result.linked).toBe(true);
    expect(fs.writeFileSync.mock.calls[0][0]).toMatch(/\.tmp$/);
    expect(fs.renameSync).toHaveBeenCalled();
    expect(written()['user-1']).toEqual([expect.objectContaining({ name: 'Judgement' })]);
  });

  it('refuses a character somebody else already claimed, and names them', () => {
    fileContains({ 'user-2': [JUDY] });

    expect(linkCharacter('user-1', JUDY)).toMatchObject({
      linked: false,
      reason: 'claimed',
      claimedBy: 'user-2'
    });
  });

  it('lets the same person re-link without complaint about ownership', () => {
    fileContains({ 'user-1': [JUDY] });
    expect(linkCharacter('user-1', JUDY)).toMatchObject({ linked: false, reason: 'duplicate' });
  });

  it('refuses once a user hits the character cap', () => {
    fileContains({
      'user-1': Array.from({ length: MAX_CHARACTERS_PER_USER }, (_, i) => ({
        name: `Alt${i}`,
        surname: 'Smith'
      }))
    });

    expect(linkCharacter('user-1', JUDY)).toMatchObject({ linked: false, reason: 'full' });
  });

  it('moves a claimed character when an admin forces it', () => {
    // An admin assigning a character is usually settling exactly the dispute
    // that a member's own claim would be refused for.
    fileContains({ 'user-2': [JUDY] });

    const result = linkCharacter('user-1', JUDY, { force: true });

    expect(result).toMatchObject({ linked: true, movedFrom: 'user-2' });
  });

  it('takes it off the previous holder in the same write', () => {
    fileContains({ 'user-2': [JUDY, { ...JUDY, name: 'Other' }] });

    linkCharacter('user-1', JUDY, { force: true });

    expect(written()['user-2']).toEqual([expect.objectContaining({ name: 'Other' })]);
    expect(written()['user-1']).toEqual([expect.objectContaining({ name: 'Judgement' })]);
  });

  it('still refuses a duplicate even when forced', () => {
    fileContains({ 'user-1': [JUDY] });
    expect(linkCharacter('user-1', JUDY, { force: true })).toMatchObject({ reason: 'duplicate' });
  });

  it('reports no move when nobody held it', () => {
    fileMissing();
    expect(linkCharacter('user-1', JUDY, { force: true }).movedFrom).toBeUndefined();
  });

  it('refuses a character with no surname', () => {
    fileMissing();
    expect(linkCharacter('user-1', { name: 'Judgement' })).toMatchObject({
      linked: false,
      reason: 'incomplete'
    });
  });

  it('refuses a character with no name', () => {
    fileMissing();
    expect(linkCharacter('user-1', { surname: 'Judy' })).toMatchObject({
      linked: false,
      reason: 'incomplete'
    });
  });
});

describe('unlinkCharacter', () => {
  it('removes one character', () => {
    fileContains({ 'user-1': [JUDY, { ...JUDY, name: 'Alt' }] });
    const result = unlinkCharacter('user-1', { name: 'judgement' });

    expect(result.removed).toBe(true);
    expect(result.characters).toEqual([expect.objectContaining({ name: 'Alt' })]);
  });

  it('narrows by surname when the same first name is linked twice', () => {
    fileContains({ 'user-1': [JUDY, { ...JUDY, name: 'Judgement', surname: 'Smith' }] });
    unlinkCharacter('user-1', { name: 'Judgement', surname: 'Smith' });

    expect(written()['user-1']).toEqual([expect.objectContaining({ surname: 'Judy' })]);
  });

  it('reports a miss without writing', () => {
    fileContains({ 'user-1': [JUDY] });

    expect(unlinkCharacter('user-1', { name: 'Nobody' }).removed).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('forget', () => {
  it('deletes everything stored for a user', () => {
    fileContains({ 'user-1': [JUDY], 'user-2': [{ ...JUDY, name: 'Other' }] });

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
      'user-1': [JUDY],
      'user-2': [{ name: 'Mindbugger', surname: 'Smith' }]
    });

    expect(index.get(characterKey({ name: 'judgement', surname: 'judy' }))).toBe('user-1');
    expect(index.get(characterKey({ name: 'Mindbugger', surname: 'Smith' }))).toBe('user-2');
  });

  it('is empty when nobody has linked, which reports must tolerate', () => {
    expect(buildOwnerIndex({}).size).toBe(0);
  });
});

describe('main characters', () => {
  it('makes the first linked character the main', () => {
    fileMissing();
    linkCharacter('user-1', JUDY);

    expect(written()['user-1'][0].main).toBe(true);
  });

  it('leaves the main alone when a second character is added', () => {
    fileContains({ 'user-1': [{ ...JUDY, main: true }] });
    linkCharacter('user-1', { ...JUDY, name: 'Alt' });

    const stored = written()['user-1'];

    expect(stored.find(c => c.name === 'Judgement').main).toBe(true);
    expect(stored.find(c => c.name === 'Alt').main).toBe(false);
  });

  it('collapses two mains down to one', () => {
    // Everything downstream assumes exactly one; two would give an unstable
    // nickname.
    const links = normalizeLinks({
      'user-1': [
        { ...JUDY, name: 'A', main: true },
        { ...JUDY, name: 'B', main: true }
      ]
    });

    expect(links['user-1'].filter(c => c.main)).toHaveLength(1);
  });

  it('promotes somebody when none is flagged', () => {
    const links = normalizeLinks({ 'user-1': [{ ...JUDY, name: 'A' }, { ...JUDY, name: 'B' }] });

    expect(links['user-1'][0].main).toBe(true);
  });

  it('promotes a replacement when the main is unlinked', () => {
    fileContains({
      'user-1': [{ ...JUDY, main: true }, { ...JUDY, name: 'Alt', main: false }]
    });

    unlinkCharacter('user-1', { name: 'Judgement' });

    expect(written()['user-1'][0]).toMatchObject({ name: 'Alt', main: true });
  });

  it('moves the main on request', () => {
    fileContains({
      'user-1': [{ ...JUDY, main: true }, { ...JUDY, name: 'Alt', main: false }]
    });

    expect(setMain('user-1', { name: 'Alt' })).toMatchObject({ changed: true });
    expect(written()['user-1'].find(c => c.main).name).toBe('Alt');
  });

  it('reports a character the person has not linked', () => {
    fileContains({ 'user-1': [{ ...JUDY, main: true }] });

    expect(setMain('user-1', { name: 'Nobody' })).toMatchObject({
      changed: false,
      reason: 'not-linked'
    });
  });

  it('reports a character that is already the main, without rewriting', () => {
    fileContains({ 'user-1': [{ ...JUDY, main: true }] });

    expect(setMain('user-1', { name: 'Judgement' })).toMatchObject({ reason: 'already-main' });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('reads back the main', () => {
    fileContains({ 'user-1': [{ ...JUDY, main: false }, { ...JUDY, name: 'Alt', main: true }] });
    expect(mainFor('user-1').name).toBe('Alt');
  });

  it('is null for somebody who has linked nothing', () => {
    fileMissing();
    expect(mainFor('nobody')).toBeNull();
  });
});
