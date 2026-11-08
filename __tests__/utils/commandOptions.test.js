const { SlashCommandBuilder } = require('discord.js');

jest.mock('../../utils/reports/links', () => ({ mainFor: jest.fn(() => null) }));
const { mainFor } = require('../../utils/reports/links');
const {
  addRegionOption,
  addSurnameOption,
  resolveCharacterTarget,
  resolveRegion,
  resolveScope
} = require('../../utils/commandOptions');

function builder() {
  return new SlashCommandBuilder().setName('example').setDescription('An example.');
}

function interaction(options = {}, user = { id: 'user-1' }) {
  return {
    user,
    options: { getString: name => (name in options ? options[name] : null) }
  };
}

describe('addRegionOption', () => {
  it('offers the four supported regions', () => {
    const json = addRegionOption(builder()).toJSON();
    const region = json.options.find(option => option.name === 'region');

    expect(region.required).toBeFalsy();
    expect(region.choices.map(choice => choice.value)).toEqual(['us', 'eu', 'kr', 'tw']);
  });
});

describe('resolveRegion', () => {
  const config = { blizzard: { region: 'us' } };

  it('prefers what the user typed', () => {
    expect(resolveRegion(interaction({ region: 'eu' }), config)).toBe('eu');
  });

  it('falls back to the configured default', () => {
    expect(resolveRegion(interaction(), config)).toBe('us');
  });

  it('ignores an unrecognised value', () => {
    expect(resolveRegion(interaction({ region: 'cn' }), config)).toBe('us');
  });
});

describe('resolveScope', () => {
  it('is just the region and its uppercase label — there is no game to pick', () => {
    expect(resolveScope(interaction({ region: 'eu' }), { blizzard: { region: 'us' } })).toEqual({
      region: 'eu',
      label: 'EU'
    });
  });

  it('falls back to the configured region', () => {
    expect(resolveScope(interaction(), { blizzard: { region: 'us' } })).toEqual({
      region: 'us',
      label: 'US'
    });
  });

  it('prefers a fallback region (a resolved main) over the configured default', () => {
    expect(
      resolveScope(interaction(), { blizzard: { region: 'us' } }, { fallbackRegion: 'eu' })
    ).toEqual({ region: 'eu', label: 'EU' });
  });

  it('still prefers an explicit region option over the fallback', () => {
    expect(
      resolveScope(interaction({ region: 'kr' }), { blizzard: { region: 'us' } }, { fallbackRegion: 'eu' })
    ).toEqual({ region: 'kr', label: 'KR' });
  });
});

describe('addSurnameOption', () => {
  it('adds an optional surname', () => {
    const json = addSurnameOption(builder()).toJSON();
    const surname = json.options.find(option => option.name === 'surname');

    expect(surname.required).toBeFalsy();
  });
});

describe('resolveCharacterTarget', () => {
  it('accepts a hyphenated name', () => {
    const target = resolveCharacterTarget({ interaction: interaction({ character: 'Judgement-Judy' }) });

    expect(target).toEqual({ characterName: 'judgement-judy', displayName: 'Judgement Judy' });
  });

  it('accepts a space-separated name', () => {
    const target = resolveCharacterTarget({ interaction: interaction({ character: 'Judgement Judy' }) });

    expect(target.characterName).toBe('judgement-judy');
  });

  it('accepts a separate surname option', () => {
    const target = resolveCharacterTarget({
      interaction: interaction({ character: 'Judgement', surname: 'Judy' })
    });

    expect(target.characterName).toBe('judgement-judy');
  });

  it('prefers the surname option over a hyphen in the name', () => {
    const target = resolveCharacterTarget({
      interaction: interaction({ character: 'Judgement-Wrong', surname: 'Judy' })
    });

    expect(target.characterName).toBe('judgement-judy');
  });

  it('is case-insensitive, and strips punctuation inside each half', () => {
    const target = resolveCharacterTarget({ interaction: interaction({ character: "MAL'GANIS-VanCleef" }) });

    expect(target.characterName).toBe('malganis-vancleef');
  });

  it('asks for a surname instead of guessing a one-word address', () => {
    const target = resolveCharacterTarget({ interaction: interaction({ character: 'Judgement' }) });

    expect(target.error).toContain('surname');
    expect(target.characterName).toBeUndefined();
  });

  it('reports an empty character name', () => {
    expect(resolveCharacterTarget({ interaction: interaction({}) }).error).toContain(
      'No character name'
    );
  });

  it('reads a non-default option name when asked to', () => {
    const target = resolveCharacterTarget({
      interaction: interaction({ alt: 'Judgement-Judy' }),
      characterOption: 'alt'
    });

    expect(target.characterName).toBe('judgement-judy');
  });

  describe('fallbackToMain', () => {
    afterEach(() => mainFor.mockReset().mockReturnValue(null));

    it('does not fall back unless asked to', () => {
      expect(resolveCharacterTarget({ interaction: interaction({}) }).error).toContain(
        'No character name'
      );
      expect(mainFor).not.toHaveBeenCalled();
    });

    it('resolves the caller\'s linked main when nothing was typed', () => {
      mainFor.mockReturnValue({ name: 'Judgement', surname: 'Judy', region: 'eu', main: true });

      const target = resolveCharacterTarget({
        interaction: interaction({}, { id: 'user-42' }),
        fallbackToMain: true
      });

      expect(mainFor).toHaveBeenCalledWith('user-42');
      expect(target).toEqual({
        characterName: 'judgement-judy',
        displayName: 'Judgement Judy',
        region: 'eu'
      });
    });

    it('still honours an explicitly typed character over the caller\'s main', () => {
      mainFor.mockReturnValue({ name: 'Someone', surname: 'Else', region: 'eu', main: true });

      const target = resolveCharacterTarget({
        interaction: interaction({ character: 'Judgement-Judy' }),
        fallbackToMain: true
      });

      expect(mainFor).not.toHaveBeenCalled();
      expect(target.characterName).toBe('judgement-judy');
    });

    it('errors by name when the caller has no linked main', () => {
      const target = resolveCharacterTarget({ interaction: interaction({}), fallbackToMain: true });

      expect(target.error).toContain('no linked main');
    });
  });
});
