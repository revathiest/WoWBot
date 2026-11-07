jest.mock('../../utils/blizzard/realms', () => ({ resolveRealm: jest.fn() }));

const { SlashCommandBuilder } = require('discord.js');
const { resolveRealm } = require('../../utils/blizzard/realms');
const {
  addRealmOption,
  addSurnameOption,
  resolveCharacterTarget,
  resolveRealmName,
  resolveRealmTarget,
  resolveScope
} = require('../../utils/commandOptions');

const configWith = realm => ({ blizzard: { realm, region: 'us', game: 'anniversary', locale: 'en_US' } });

function builder() {
  return new SlashCommandBuilder().setName('example').setDescription('An example.');
}

function interaction(options = {}) {
  return { options: { getString: name => (name in options ? options[name] : null) } };
}

describe('addRealmOption', () => {
  // Never required, even with no home realm. One definition is registered for
  // every flavour, and Classic Forever has no realms — Discord would otherwise
  // demand a realm from the one flavour that cannot use it. The requirement
  // moved to resolveCharacterTarget, which can see the chosen game.
  it('stays optional even when no home realm is configured', () => {
    const json = addRealmOption(builder(), configWith(null)).toJSON();
    const realm = json.options.find(o => o.name === 'realm');

    expect(realm.required).toBeFalsy();
    expect(realm.description).toContain('e.g.');
    expect(realm.description).toContain('Classic Forever');
  });

  it('is optional and names the default when one is configured', () => {
    const json = addRealmOption(builder(), configWith('Nightslayer')).toJSON();
    const realm = json.options.find(o => o.name === 'realm');

    expect(realm.required).toBeFalsy();
    expect(realm.description).toContain('Nightslayer');
  });
});

describe('resolveRealmName', () => {
  it('prefers what the user typed', () => {
    expect(resolveRealmName(interaction({ realm: 'Dreamscythe' }), configWith('Nightslayer')))
      .toBe('Dreamscythe');
  });

  it('falls back to the configured home realm', () => {
    expect(resolveRealmName(interaction(), configWith('Nightslayer'))).toBe('Nightslayer');
  });

  it('treats a blank option as absent', () => {
    expect(resolveRealmName(interaction({ realm: '   ' }), configWith('Nightslayer')))
      .toBe('Nightslayer');
  });

  it('is null when there is neither an option nor a default', () => {
    expect(resolveRealmName(interaction(), configWith(null))).toBeNull();
  });
});

describe('resolveScope', () => {
  it('labels retail with the region alone', () => {
    const config = { blizzard: { region: 'us', game: 'retail', realm: null } };
    expect(resolveScope(interaction(), config).label).toBe('US');
  });

  it('appends the game version when it is not retail', () => {
    const scope = resolveScope(interaction(), configWith('Nightslayer'));
    expect(scope).toMatchObject({ region: 'us', game: 'anniversary', label: 'US · TBC Anniversary' });
  });

  it('honours explicit options over the configured defaults', () => {
    const scope = resolveScope(interaction({ region: 'eu', game: 'retail' }), configWith('X'));
    expect(scope).toMatchObject({ region: 'eu', game: 'retail', label: 'EU' });
  });
});

describe('addSurnameOption', () => {
  it('adds an optional surname, since only Classic Forever needs one', () => {
    const json = addSurnameOption(builder()).toJSON();
    const surname = json.options.find(option => option.name === 'surname');

    expect(surname.required).toBeFalsy();
    expect(surname.description).toContain('Classic Forever');
  });
});

describe('resolveCharacterTarget on realmless flavours', () => {
  const scope = { region: 'eu', game: 'forever', label: 'EU · Classic Forever' };

  beforeEach(() => jest.clearAllMocks());

  it('accepts a hyphenated name', async () => {
    const target = await resolveCharacterTarget({
      interaction: interaction({ character: 'Judgement-Judy' }),
      scope
    });

    expect(target).toMatchObject({
      realmSlug: null,
      characterName: 'judgement-judy',
      displayName: 'Judgement Judy'
    });
  });

  it('accepts a separate surname option', async () => {
    const target = await resolveCharacterTarget({
      interaction: interaction({ character: 'Judgement', surname: 'Judy' }),
      scope
    });

    expect(target.characterName).toBe('judgement-judy');
  });

  it('prefers the surname option over a hyphen in the name', async () => {
    const target = await resolveCharacterTarget({
      interaction: interaction({ character: 'Judgement-Wrong', surname: 'Judy' }),
      scope
    });

    expect(target.characterName).toBe('judgement-judy');
  });

  it('never resolves a realm, and ignores the realm option entirely', async () => {
    await resolveCharacterTarget({
      interaction: interaction({ character: 'Judgement-Judy', realm: 'Whitemane' }),
      scope
    });

    // Resolving a realm here would be meaningless: this flavour has none.
    expect(resolveRealm).not.toHaveBeenCalled();
  });

  it('asks for a surname instead of guessing a one-word address', async () => {
    const target = await resolveCharacterTarget({
      interaction: interaction({ character: 'Judgement' }),
      scope
    });

    expect(target.error).toContain('surname');
    expect(target.characterName).toBeUndefined();
  });

  it('reports an empty character name', async () => {
    const target = await resolveCharacterTarget({ interaction: interaction({}), scope });
    expect(target.error).toContain('No character name');
  });
});

describe('resolveCharacterTarget on realm flavours', () => {
  const scope = { region: 'us', game: 'retail', label: 'US' };

  beforeEach(() => {
    jest.clearAllMocks();
    resolveRealm.mockResolvedValue({ slug: 'area-52', name: 'Area 52', resolved: true });
  });

  it('resolves the realm and keeps the character name separate', async () => {
    const target = await resolveCharacterTarget({
      interaction: interaction({ character: 'Thrall', realm: 'Area 52' }),
      scope,
      config: configWith(null)
    });

    expect(target).toMatchObject({
      realmSlug: 'area-52',
      characterName: 'Thrall',
      realmLabel: 'Area 52',
      resolved: true
    });
  });

  it('falls back to the configured home realm', async () => {
    await resolveCharacterTarget({
      interaction: interaction({ character: 'Thrall' }),
      scope,
      config: configWith('Nightslayer')
    });

    expect(resolveRealm).toHaveBeenCalledWith('Nightslayer', { region: 'us', game: 'retail' });
  });

  it('asks for a realm when there is none to fall back to', async () => {
    const target = await resolveCharacterTarget({
      interaction: interaction({ character: 'Thrall' }),
      scope,
      config: configWith(null)
    });

    // Discord cannot enforce this, because one definition serves every flavour.
    expect(target.error).toContain('realm');
    expect(resolveRealm).not.toHaveBeenCalled();
  });
});

describe('resolveRealmTarget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveRealm.mockResolvedValue({ slug: 'area-52', name: 'Area 52', resolved: true });
  });

  it('resolves to a null slug on realmless flavours, and cannot fail', async () => {
    const target = await resolveRealmTarget({
      interaction: interaction({}),
      scope: { region: 'eu', game: 'forever', label: 'EU · Classic Forever' }
    });

    expect(target).toEqual({ realmSlug: null, realmLabel: null, resolved: true });
    expect(resolveRealm).not.toHaveBeenCalled();
  });

  it('resolves a realm normally everywhere else', async () => {
    const target = await resolveRealmTarget({
      interaction: interaction({ realm: 'Area 52' }),
      scope: { region: 'us', game: 'retail', label: 'US' },
      config: configWith(null)
    });

    expect(target).toEqual({ realmSlug: 'area-52', realmLabel: 'Area 52', resolved: true });
  });

  it('reports a missing realm on flavours that need one', async () => {
    const target = await resolveRealmTarget({
      interaction: interaction({}),
      scope: { region: 'us', game: 'retail', label: 'US' },
      config: configWith(null)
    });

    expect(target.error).toContain('realm');
  });
});
