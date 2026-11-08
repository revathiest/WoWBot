jest.mock('../../utils/voice/store');

const { PermissionFlagsBits } = require('discord.js');
const store = require('../../utils/voice/store');
const command = require('../../commands/admin/voice');
const { createInteraction } = require('../helpers/interaction');

function interaction({ subcommand, options = {}, permissions = true } = {}) {
  return createInteraction({ commandName: 'voice', subcommand, options, permissions });
}

function payloadOf(fake) {
  const call = fake.editReply.mock.calls.at(-1) ?? fake.reply.mock.calls.at(-1);
  return call[0];
}

function said(fake) {
  const payload = payloadOf(fake);
  return typeof payload === 'string' ? payload : payload.content;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('command shape', () => {
  it('is named /voice and declares Manage Server', () => {
    const json = command.data.toJSON();

    expect(json.name).toBe('voice');
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
  });
});

describe('execute', () => {
  it('refuses without Manage Server, even though Discord also hides the command', async () => {
    const target = interaction({ subcommand: 'status', permissions: false });
    await command.execute(target);

    expect(said(target)).toContain('Manage Server');
    expect(store.getSettings).not.toHaveBeenCalled();
  });

  describe('status', () => {
    it('reports nothing set up', async () => {
      store.getSettings.mockReturnValue(null);
      const target = interaction({ subcommand: 'status' });

      await command.execute(target);

      const embed = payloadOf(target).embeds[0].toJSON();
      expect(embed.description).toContain('Not set up');
    });

    it('reports the configured trigger and category', async () => {
      store.getSettings.mockReturnValue({ triggerChannelId: 't1', categoryId: 'cat1' });
      const target = interaction({ subcommand: 'status' });

      await command.execute(target);

      const embed = payloadOf(target).embeds[0].toJSON();
      expect(embed.fields.find(f => f.name === 'Trigger channel').value).toBe('<#t1>');
      expect(embed.fields.find(f => f.name === 'Created in').value).toBe('<#cat1>');
    });

    it('describes an unset category as using the trigger\'s own', async () => {
      store.getSettings.mockReturnValue({ triggerChannelId: 't1', categoryId: null });
      const target = interaction({ subcommand: 'status' });

      await command.execute(target);

      const embed = payloadOf(target).embeds[0].toJSON();
      expect(embed.fields.find(f => f.name === 'Created in').value).toContain('own category');
    });
  });

  describe('set-channel', () => {
    it('saves the trigger channel', async () => {
      const target = interaction({
        subcommand: 'set-channel',
        options: { channel: { id: 'trig-1' } }
      });

      await command.execute(target);

      expect(store.setSettings).toHaveBeenCalledWith('test-guild', { triggerChannelId: 'trig-1' });
      expect(said(target)).toContain('<#trig-1>');
    });

    it('saves a configured category alongside the trigger channel', async () => {
      const target = interaction({
        subcommand: 'set-channel',
        options: { channel: { id: 'trig-1' }, category: { id: 'cat-1' } }
      });

      await command.execute(target);

      expect(store.setSettings).toHaveBeenCalledWith('test-guild', {
        triggerChannelId: 'trig-1',
        categoryId: 'cat-1'
      });
    });

    it('leaves a previously configured category untouched when none is given again', async () => {
      const target = interaction({
        subcommand: 'set-channel',
        options: { channel: { id: 'trig-2' } }
      });

      await command.execute(target);

      expect(store.setSettings).toHaveBeenCalledWith('test-guild', { triggerChannelId: 'trig-2' });
      expect(store.setSettings.mock.calls[0][1]).not.toHaveProperty('categoryId');
    });
  });

  describe('disable', () => {
    it('clears the guild\'s setup', async () => {
      const target = interaction({ subcommand: 'disable' });

      await command.execute(target);

      expect(store.clearSettings).toHaveBeenCalledWith('test-guild');
      expect(said(target)).toContain('off');
    });
  });
});
