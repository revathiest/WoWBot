const { SlashCommandBuilder } = require('discord.js');
const {
  addRealmOption,
  resolveRealmName,
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
  it('is required when no home realm is configured', () => {
    const json = addRealmOption(builder(), configWith(null)).toJSON();
    const realm = json.options.find(o => o.name === 'realm');

    expect(realm.required).toBe(true);
    expect(realm.description).toContain('e.g.');
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
