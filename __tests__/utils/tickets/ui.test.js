const {
  CREATE_BUTTON_ID,
  CREATE_MODAL_ID,
  SUBJECT_INPUT_ID,
  buildClosedEmbed,
  buildHistoryEmbed,
  buildLobbyComponents,
  buildLobbyEmbed,
  buildTicketChannelName,
  buildTicketControls,
  buildTicketEmbed,
  buildTicketModal,
  historyLine,
  sanitizeNameSegment
} = require('../../../utils/tickets/ui');

/** The plain JSON of the first (and only) action row. */
function buttonsOf(components) {
  return components[0].toJSON().components;
}

describe('sanitizeNameSegment', () => {
  it('lowercases and hyphenates', () => {
    expect(sanitizeNameSegment('Big Red Dog')).toBe('big-red-dog');
  });

  it('turns punctuation into separators', () => {
    // Note this is NOT the realm-slug rule from utils/wow.js, which DELETES
    // apostrophes. A channel name has no such constraint, and hyphenating reads
    // better than running words together.
    expect(sanitizeNameSegment("Mal'Ganis!!")).toBe('mal-ganis');
  });

  it('collapses runs and trims stray hyphens', () => {
    expect(sanitizeNameSegment('  --a   b--  ')).toBe('a-b');
  });

  it('falls back for a name that survives as nothing', () => {
    // Emoji-only and non-Latin display names are common.
    expect(sanitizeNameSegment('🎉🎉')).toBe('user');
    expect(sanitizeNameSegment('')).toBe('user');
    expect(sanitizeNameSegment(null)).toBe('user');
  });

  it('truncates a very long name, since channel names are capped', () => {
    expect(sanitizeNameSegment('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('buildTicketChannelName', () => {
  it('reads as ticket-name-id', () => {
    expect(buildTicketChannelName('Butud', 42)).toBe('ticket-butud-42');
  });

  it('stays inside Discord\'s 100-character channel name limit', () => {
    expect(buildTicketChannelName('x'.repeat(200), 999999).length).toBeLessThanOrEqual(100);
  });
});

describe('buildLobbyEmbed', () => {
  it('explains the flow', () => {
    const embed = buildLobbyEmbed('My Guild').toJSON();

    expect(embed.title).toBe('Need Assistance?');
    expect(embed.fields[0].value).toContain('Open Ticket');
  });

  it('names the server when it can', () => {
    expect(buildLobbyEmbed('My Guild').toJSON().fields[1].value).toContain('My Guild');
  });

  it('still reads correctly without a server name', () => {
    expect(buildLobbyEmbed(null).toJSON().fields[1].value).toContain('Tickets are intended');
  });
});

describe('buildLobbyComponents', () => {
  it('carries the custom id the handler routes on', () => {
    expect(buttonsOf(buildLobbyComponents())[0].custom_id).toBe(CREATE_BUTTON_ID);
  });
});

describe('buildTicketControls', () => {
  it('offers claim and close on a fresh ticket', () => {
    const buttons = buttonsOf(buildTicketControls(7));

    expect(buttons[0].custom_id).toBe('ticket:claim:7');
    expect(buttons[1].custom_id).toBe('ticket:close:7');
    expect(buttons[0].disabled).toBeFalsy();
  });

  it('locks the claim button once somebody has it', () => {
    const [claim] = buttonsOf(buildTicketControls(7, 'Alex'));

    expect(claim.label).toBe('Claimed by Alex');
    expect(claim.disabled).toBe(true);
  });

  it('disables everything once closed', () => {
    const buttons = buttonsOf(buildTicketControls(7, 'Alex', { closed: true }));

    expect(buttons[0].disabled).toBe(true);
    expect(buttons[1].disabled).toBe(true);
    expect(buttons[1].label).toBe('Closed');
  });

  it('keeps a long claimer name inside the button label limit', () => {
    const [claim] = buttonsOf(buildTicketControls(7, 'x'.repeat(200)));
    expect(claim.label.length).toBeLessThanOrEqual(80);
  });
});

describe('buildTicketModal', () => {
  it('uses the custom id the handler routes on', () => {
    expect(buildTicketModal().toJSON().custom_id).toBe(CREATE_MODAL_ID);
  });

  it('asks one required paragraph question', () => {
    const input = buildTicketModal().toJSON().components[0].components[0];

    expect(input.custom_id).toBe(SUBJECT_INPUT_ID);
    expect(input.required).toBe(true);
    expect(input.min_length).toBe(10);
    expect(input.max_length).toBe(400);
  });
});

describe('buildTicketEmbed', () => {
  it('titles with the ticket number and credits the opener', () => {
    const embed = buildTicketEmbed({
      user: { id: 'u1' },
      description: 'My account is broken',
      ticketId: 12
    }).toJSON();

    expect(embed.title).toBe('Ticket #12');
    expect(embed.description).toBe('My account is broken');
    expect(embed.fields[0].value).toBe('<@u1>');
  });
});

describe('buildClosedEmbed', () => {
  it('records who opened and who closed it', () => {
    const embed = buildClosedEmbed({
      ticket: { id: 3, userId: 'u1', claimedBy: null },
      closedBy: 'mod1'
    }).toJSON();

    expect(embed.title).toBe('Ticket #3 closed');
    expect(embed.fields.map(f => f.value)).toEqual(['<@u1>', '<@mod1>']);
  });

  it('includes the claimer when there was one', () => {
    const embed = buildClosedEmbed({
      ticket: { id: 3, userId: 'u1', claimedBy: 'mod2' },
      closedBy: 'mod1'
    }).toJSON();

    expect(embed.fields.some(f => f.name === 'Claimed by')).toBe(true);
  });
});

describe('historyLine', () => {
  it('marks an open ticket', () => {
    expect(historyLine({ id: 1, userId: 'u1', description: 'x', createdAt: 1000 })).toContain('**open**');
  });

  it('marks a closed ticket', () => {
    expect(
      historyLine({ id: 1, userId: 'u1', description: 'x', createdAt: 1000, closedAt: 2000 })
    ).toContain('**closed**');
  });

  it('truncates a long description', () => {
    const line = historyLine({ id: 1, userId: 'u1', description: 'x'.repeat(300), createdAt: 1000 });
    expect(line).toContain('…');
  });

  it('flattens newlines so one ticket stays one line', () => {
    const line = historyLine({ id: 1, userId: 'u1', description: 'a\n\nb', createdAt: 1000 });
    expect(line).toContain('> a b');
  });
});

describe('buildHistoryEmbed', () => {
  it('lists tickets', () => {
    const embed = buildHistoryEmbed({
      tickets: [{ id: 1, userId: 'u1', description: 'x', createdAt: 1000 }]
    }).toJSON();

    expect(embed.description).toContain('`#1`');
  });

  it('says so when a member has never opened one', () => {
    expect(buildHistoryEmbed({ tickets: [], userId: 'u1' }).toJSON().description).toContain('never opened');
  });

  it('says so when the server has none at all', () => {
    expect(buildHistoryEmbed({ tickets: [] }).toJSON().description).toContain('No tickets');
  });
});
