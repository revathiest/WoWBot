jest.mock('../../utils/tickets/core', () => ({ handleComponent: jest.fn(async () => false) }));
jest.mock('../../utils/reports/component', () => ({ handleComponent: jest.fn(async () => false) }));

const { handleComponent: ticket } = require('../../utils/tickets/core');
const { handleComponent: report } = require('../../utils/reports/component');
const { HANDLERS, routeComponent } = require('../../utils/components');

beforeEach(() => jest.clearAllMocks());

describe('routeComponent', () => {
  it('sends a ticket component to the ticket system', async () => {
    ticket.mockResolvedValue(true);

    expect(await routeComponent({ customId: 'ticket:create' })).toBe(true);
    expect(report).not.toHaveBeenCalled();
  });

  it('sends a report component to the report system', async () => {
    report.mockResolvedValue(true);

    expect(await routeComponent({ customId: 'report:roster:key' })).toBe(true);
    expect(ticket).not.toHaveBeenCalled();
  });

  it('ignores a component nothing claims', async () => {
    expect(await routeComponent({ customId: 'poll:vote:1' })).toBe(false);
    expect(ticket).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('tolerates a missing custom id', async () => {
    expect(await routeComponent({})).toBe(false);
  });

  it('reports false when the owning handler declines it', async () => {
    // A prefix match is not a promise to handle it.
    ticket.mockResolvedValue(false);
    expect(await routeComponent({ customId: 'ticket:unknown' })).toBe(false);
  });

  it('registers every feature that owns components', () => {
    expect(HANDLERS.map(h => h.prefix)).toEqual(['ticket:', 'report:']);
  });
});
