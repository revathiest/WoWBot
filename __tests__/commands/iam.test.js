jest.mock('../../utils/blizzard/profile');
jest.mock('../../utils/blizzard/realms');
jest.mock('../../utils/reports/links', () => ({
  ...jest.requireActual('../../utils/reports/links'),
  charactersFor: jest.fn(),
  forget: jest.fn(),
  linkCharacter: jest.fn(),
  unlinkCharacter: jest.fn()
}));

const { getCharacterProfile } = require('../../utils/blizzard/profile');
const { resolveRealm } = require('../../utils/blizzard/realms');
const {
  MAX_CHARACTERS_PER_USER,
  charactersFor,
  forget,
  linkCharacter,
  unlinkCharacter
} = require('../../utils/reports/links');
const { BlizzardApiError } = require('../../utils/blizzard/client');
const command = require('../../commands/wow/iam');
const { createInteraction } = require('../helpers/interaction');

const BUTUD = { name: 'Butud', realm: 'Nightslayer', region: 'us', game: 'anniversary' };

function interaction({
  subcommand,
  subcommandGroup = null,
  options = {},
  user = { id: 'user-1' },
  permissions = true
} = {}) {
  return createInteraction({
    commandName: 'iam',
    subcommand,
    subcommandGroup,
    options,
    user,
    permissions
  });
}

function payloadOf(fake) {
  const call = fake.editReply.mock.calls.at(-1) ?? fake.reply.mock.calls.at(-1);
  return call[0];
}

function said(fake) {
  const payload = payloadOf(fake);
  if (typeof payload === 'string') return payload;
  if (payload.content) return payload.content;
  return payload.embeds[0].toJSON().description;
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveRealm.mockResolvedValue({ slug: 'nightslayer', name: 'Nightslayer', resolved: true });
  getCharacterProfile.mockResolvedValue({ name: 'Butud', character_class: { name: 'Rogue' } });
  linkCharacter.mockReturnValue({ linked: true, reason: null });
  unlinkCharacter.mockReturnValue({ removed: true, characters: [] });
  charactersFor.mockReturnValue([]);
  forget.mockReturnValue({ removed: 1 });
});

describe('command shape', () => {
  it('needs no permissions, since it is self-service', () => {
    expect(command.data.toJSON().default_member_permissions).toBeUndefined();
  });

  it('offers add, remove, list, forget, and the admin manage group', () => {
    expect(command.data.toJSON().options.map(option => option.name)).toEqual([
      'add',
      'remove',
      'list',
      'forget',
      'manage'
    ]);
  });
});

describe('/iam add', () => {
  it('confirms the character exists before storing it', async () => {
    // A typo that never matches a roster would otherwise sit in the file forever.
    const fake = interaction({ subcommand: 'add', options: { character: 'Butud' } });
    await command.execute(fake);

    expect(getCharacterProfile).toHaveBeenCalledWith('nightslayer', 'Butud', expect.any(Object));
    expect(linkCharacter).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ name: 'Butud' }),
      { force: false }
    );
  });

  it('stores Blizzard\'s casing rather than what was typed', async () => {
    const fake = interaction({ subcommand: 'add', options: { character: 'bUtUd' } });
    await command.execute(fake);

    expect(linkCharacter).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ name: 'Butud' }),
      { force: false }
    );
  });

  it('replies only to the person running it', async () => {
    const fake = interaction({ subcommand: 'add', options: { character: 'Butud' } });
    await command.execute(fake);

    expect(fake.deferReply).toHaveBeenCalledWith(expect.objectContaining({ flags: expect.anything() }));
  });

  it('names the realm it tried when the character does not exist', async () => {
    getCharacterProfile.mockRejectedValue(new BlizzardApiError('Not found.', { status: 404 }));
    const fake = interaction({ subcommand: 'add', options: { character: 'Typo' } });

    await command.execute(fake);

    expect(said(fake)).toContain('nightslayer');
    expect(linkCharacter).not.toHaveBeenCalled();
  });

  it('lets a non-404 propagate to the shared error handler', async () => {
    getCharacterProfile.mockRejectedValue(new BlizzardApiError('Boom', { status: 500 }));
    const fake = interaction({ subcommand: 'add', options: { character: 'Butud' } });

    await expect(command.execute(fake)).rejects.toThrow('Boom');
  });

  it('refuses a character somebody else claimed, and points at them', async () => {
    linkCharacter.mockReturnValue({ linked: false, reason: 'claimed', claimedBy: 'user-2' });
    const fake = interaction({ subcommand: 'add', options: { character: 'Butud' } });

    await command.execute(fake);

    expect(said(fake)).toContain('<@user-2>');
  });

  it('says so when the character is already linked to you', async () => {
    linkCharacter.mockReturnValue({ linked: false, reason: 'duplicate' });
    const fake = interaction({ subcommand: 'add', options: { character: 'Butud' } });

    await command.execute(fake);

    expect(said(fake)).toContain('already linked');
  });

  it('names the cap when a user has linked too many', async () => {
    linkCharacter.mockReturnValue({ linked: false, reason: 'full' });
    const fake = interaction({ subcommand: 'add', options: { character: 'Butud' } });

    await command.execute(fake);

    expect(said(fake)).toContain(String(MAX_CHARACTERS_PER_USER));
  });
});

describe('/iam remove', () => {
  it('unlinks a character', async () => {
    const fake = interaction({ subcommand: 'remove', options: { character: 'Butud' } });
    await command.execute(fake);

    expect(unlinkCharacter).toHaveBeenCalledWith('user-1', { name: 'Butud', realm: null });
    expect(said(fake)).toContain('no longer linked');
  });

  it('reports a character that was never linked', async () => {
    unlinkCharacter.mockReturnValue({ removed: false, characters: [] });
    const fake = interaction({ subcommand: 'remove', options: { character: 'Nobody' } });

    await command.execute(fake);

    expect(said(fake)).toContain('not linked');
  });
});

describe('/iam list', () => {
  it('lists your characters', async () => {
    charactersFor.mockReturnValue([BUTUD]);
    const fake = interaction({ subcommand: 'list' });

    await command.execute(fake);

    expect(said(fake)).toContain('Butud');
  });

  it('explains how to start when nothing is linked', async () => {
    const fake = interaction({ subcommand: 'list' });
    await command.execute(fake);

    expect(said(fake)).toContain('/iam add');
  });

  it('can look at somebody else', async () => {
    const fake = interaction({ subcommand: 'list', options: { user: { id: 'user-9' } } });
    await command.execute(fake);

    expect(charactersFor).toHaveBeenCalledWith('user-9');
  });
});

describe('/iam forget', () => {
  it('deletes everything stored about the caller', async () => {
    const fake = interaction({ subcommand: 'forget' });
    await command.execute(fake);

    expect(forget).toHaveBeenCalledWith('user-1');
    expect(said(fake)).toContain('stores nothing about you');
  });

  it('is honest when there was nothing stored', async () => {
    forget.mockReturnValue({ removed: 0 });
    const fake = interaction({ subcommand: 'forget' });

    await command.execute(fake);

    expect(said(fake)).toContain('nothing stored');
  });
});

describe('buildListEmbed', () => {
  it('shows how many slots are used', () => {
    const embed = command.buildListEmbed('user-1', [BUTUD]).toJSON();
    expect(embed.footer.text).toBe(`1 of ${MAX_CHARACTERS_PER_USER} slots used`);
  });

  it('omits the footer when there is nothing to count', () => {
    expect(command.buildListEmbed('user-1', []).toJSON().footer).toBeUndefined();
  });
});

describe('characterLine', () => {
  it('names the game version, so alts across versions are distinguishable', () => {
    expect(command.characterLine(BUTUD)).toContain('TBC Anniversary');
  });
});

describe('/iam manage', () => {
  it('refuses a member without Manage Server, and points at the self-service command', async () => {
    const fake = interaction({
      subcommand: 'assign',
      subcommandGroup: 'manage',
      permissions: false,
      options: { user: { id: 'user-9' }, character: 'Butud' }
    });

    await command.execute(fake);

    expect(linkCharacter).not.toHaveBeenCalled();
    expect(said(fake)).toContain('/iam add');
  });

  it('assigns a character to somebody else', async () => {
    const fake = interaction({
      subcommand: 'assign',
      subcommandGroup: 'manage',
      options: { user: { id: 'user-9' }, character: 'Butud' }
    });

    await command.execute(fake);

    expect(linkCharacter).toHaveBeenCalledWith(
      'user-9',
      expect.objectContaining({ name: 'Butud' }),
      { force: true }
    );
    expect(said(fake)).toContain('<@user-9>');
  });

  it('verifies the character exists before assigning it', async () => {
    getCharacterProfile.mockRejectedValue(new BlizzardApiError('Not found.', { status: 404 }));

    const fake = interaction({
      subcommand: 'assign',
      subcommandGroup: 'manage',
      options: { user: { id: 'user-9' }, character: 'Typo' }
    });

    await command.execute(fake);

    expect(linkCharacter).not.toHaveBeenCalled();
  });

  it('says out loud when an assignment took the character off somebody', async () => {
    linkCharacter.mockReturnValue({ linked: true, reason: null, movedFrom: 'user-2' });

    const fake = interaction({
      subcommand: 'assign',
      subcommandGroup: 'manage',
      options: { user: { id: 'user-9' }, character: 'Butud' }
    });

    await command.execute(fake);

    expect(said(fake)).toContain('<@user-2>');
    expect(said(fake)).toContain('moved');
  });

  it('unassigns a character from somebody else', async () => {
    const fake = interaction({
      subcommand: 'unassign',
      subcommandGroup: 'manage',
      options: { user: { id: 'user-9' }, character: 'Butud' }
    });

    await command.execute(fake);

    expect(unlinkCharacter).toHaveBeenCalledWith('user-9', { name: 'Butud', realm: null });
    expect(said(fake)).toContain('<@user-9>');
  });

  it('reports a character that member never had', async () => {
    unlinkCharacter.mockReturnValue({ removed: false, characters: [] });

    const fake = interaction({
      subcommand: 'unassign',
      subcommandGroup: 'manage',
      options: { user: { id: 'user-9' }, character: 'Nobody' }
    });

    await command.execute(fake);

    expect(said(fake)).toContain('not linked to <@user-9>');
  });
});
