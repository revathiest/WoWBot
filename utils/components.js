// utils/components.js
// Routing for buttons and modals.
//
// A component belongs to whatever posted it, not to a slash command, so it
// cannot be looked up in `client.commands`. The custom id carries the owner as
// a prefix — `ticket:…`, `report:…` — and each feature claims its own here.
//
// This exists so handlers/interactionHandler.js stays what AGENTS.md says it
// is: routing and error translation, with no knowledge of any one feature.

const { handleComponent: handleTicketComponent } = require('./tickets/core');
const { handleComponent: handleReportComponent } = require('./reports/component');

/**
 * Every feature that owns components, in the order they are tried.
 *
 * A handler returns true when it has dealt with the interaction, so adding a
 * feature is a line here rather than an edit to the interaction handler.
 */
const HANDLERS = [
  { prefix: 'ticket:', handle: handleTicketComponent },
  { prefix: 'report:', handle: handleReportComponent }
];

/**
 * Offers an interaction to whichever feature owns its custom id.
 *
 * @returns {Promise<boolean>} whether anything handled it.
 */
async function routeComponent(interaction) {
  const customId = interaction.customId ?? '';

  for (const { prefix, handle } of HANDLERS) {
    if (!customId.startsWith(prefix)) continue;
    if (await handle(interaction)) return true;
  }

  return false;
}

module.exports = { HANDLERS, routeComponent };
