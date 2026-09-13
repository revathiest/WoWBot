# Agent notes

Conventions for anyone — human or agent — working in this repository.

## Shape of the project

- **CommonJS, not ESM.** `require` / `module.exports` throughout. Do not add `"type": "module"`.
- **No database.** The bot is stateless; everything comes from the Blizzard API per request.
- **No privileged intents.** Only `GatewayIntentBits.Guilds`. If a feature seems to need message content or presence, rethink it first.
- **Native `fetch`.** Node 20+ provides it. Do not add axios, node-fetch, or a request library.

## Layering

Keep these boundaries — the tests rely on them for mocking:

| Layer | Rule |
| --- | --- |
| `config/` | The only place that reads `process.env`. Everything else takes a config object or calls `readConfig()`. |
| `utils/blizzard/client.js` | The only place that calls `fetch` or knows about OAuth, namespaces, and retries. |
| `utils/blizzard/profile.js`, `gameData.js` | Thin endpoint wrappers. One function per endpoint, no formatting. |
| `commands/` | Build embeds and reply. No `fetch`, no token handling. |
| `handlers/` | Routing and error translation only. |

## Commands

- One file per command under `commands/`, exporting `data` (a `SlashCommandBuilder`), `execute(interaction)`, plus `help` and `category` strings.
- The loader is recursive and automatic. Never maintain a manual command list.
- Export `buildEmbed` (and any pure helper) so it can be tested without an interaction.
- Always `deferReply()` first — Blizzard calls routinely exceed Discord's 3-second interaction window.
- Handle `404` inside the command when a specific message helps the user (name the realm slug that was tried). Let every other error propagate; `handlers/interactionHandler.js` translates it.
- Use `addRegionOption` / `resolveRegion` from `utils/commandOptions.js` so every command takes `region` identically.

## Blizzard API gotchas

- Namespaces are mandatory: `profile-{region}` for characters, `dynamic-{region}` for realms and the token, `static-{region}` for items.
- Realm names in paths must be slugs, and character names must be lowercased — use `slugifyRealm` and `encodeCharacterName` rather than hand-rolling.
- Search endpoints return **localized maps** (`{ en_US: "..." }`) while direct document fetches return plain strings. Run anything user-visible through `localized()`.
- Realm status and population live on the **connected realm**, not the realm document.
- Mythic+ ratings are RGB component objects, not integers; `ratingColor()` packs them.
- Currency values are in copper. `formatGold()` converts.

## Testing

- `npm test` runs Jest with coverage and an 80% global threshold. Keep it passing.
- Tests live in `__tests__/`, mirroring the source layout. Only `*.test.js` files are collected, so shared helpers can live in `__tests__/helpers/`.
- Never hit the network. Mock `global.fetch` for client tests and `jest.mock` the endpoint modules for command tests.
- Use the fake interaction from `__tests__/helpers/interaction.js` rather than building one inline.
- `__tests__/fixtures/commands/` deliberately contains broken command files; the loader tests rely on them.

## Style

- Two-space indentation, single quotes, semicolons.
- Comments explain *why* something is the way it is, not what the line does. The existing comments about Blizzard's API quirks are the model.
- Emoji are used in console output and user-facing replies (✅ ❌ 🟢 ⚠️); keep that consistent.
