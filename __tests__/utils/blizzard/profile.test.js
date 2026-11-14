jest.mock('../../../utils/blizzard/client');

const { request } = require('../../../utils/blizzard/client');
const {
  characterPath,
  getCharacterEquipment,
  getCharacterMedia,
  getCharacterProfile,
  getCharacterPvpSummary
} = require('../../../utils/blizzard/profile');

beforeEach(() => {
  jest.clearAllMocks();
  request.mockResolvedValue({ ok: true });
});

describe('characterPath', () => {
  it('builds the bare character path with no suffix', () => {
    expect(characterPath('judgement-judy')).toBe('/profile/wow/character/judgement-judy');
  });

  it('appends a suffix for sub-resources', () => {
    expect(characterPath('judgement-judy', '/equipment')).toBe(
      '/profile/wow/character/judgement-judy/equipment'
    );
  });
});

describe('getCharacterProfile', () => {
  it('requests the profile under the profile namespace', async () => {
    await getCharacterProfile('judgement-judy');

    expect(request).toHaveBeenCalledWith('/profile/wow/character/judgement-judy', {
      namespace: 'profile'
    });
  });

  it('forwards caller options alongside the namespace', async () => {
    await getCharacterProfile('judgement-judy', { region: 'eu' });

    expect(request).toHaveBeenCalledWith('/profile/wow/character/judgement-judy', {
      region: 'eu',
      namespace: 'profile'
    });
  });
});

describe('getCharacterMedia', () => {
  it('requests character-media under the profile namespace', async () => {
    await getCharacterMedia('judgement-judy');

    expect(request).toHaveBeenCalledWith('/profile/wow/character/judgement-judy/character-media', {
      namespace: 'profile'
    });
  });

  it('forwards caller options alongside the namespace', async () => {
    await getCharacterMedia('judgement-judy', { region: 'eu' });

    expect(request).toHaveBeenCalledWith('/profile/wow/character/judgement-judy/character-media', {
      region: 'eu',
      namespace: 'profile'
    });
  });
});

describe('getCharacterEquipment', () => {
  it('requests equipment under the profile namespace', async () => {
    await getCharacterEquipment('judgement-judy');

    expect(request).toHaveBeenCalledWith('/profile/wow/character/judgement-judy/equipment', {
      namespace: 'profile'
    });
  });

  it('forwards caller options alongside the namespace', async () => {
    await getCharacterEquipment('judgement-judy', { region: 'eu' });

    expect(request).toHaveBeenCalledWith('/profile/wow/character/judgement-judy/equipment', {
      region: 'eu',
      namespace: 'profile'
    });
  });
});

describe('getCharacterPvpSummary', () => {
  it('requests the pvp-summary under the profile namespace', async () => {
    await getCharacterPvpSummary('judgement-judy');

    expect(request).toHaveBeenCalledWith('/profile/wow/character/judgement-judy/pvp-summary', {
      namespace: 'profile'
    });
  });

  it('forwards caller options alongside the namespace', async () => {
    await getCharacterPvpSummary('judgement-judy', { region: 'eu' });

    expect(request).toHaveBeenCalledWith('/profile/wow/character/judgement-judy/pvp-summary', {
      region: 'eu',
      namespace: 'profile'
    });
  });
});
