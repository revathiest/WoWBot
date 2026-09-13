# Agent notes

Conventions for anyone — human or agent — working in this repository.

## Shape of the project

- **CommonJS, not ESM.** `require` / `module.exports` throughout. Do not add `"type": "module"`.
- **No database.** Everything from the Blizzard API is fetched per request. The single exception is `data/spam.json`, which holds moderation settings so `/spam configure` survives a restart. Do not add a second store without a very good reason, and never put user data in it.
- **Privileged intents: `MessageContent` and `GuildMembers` are enabled, for spam detection only.** They must be switched on in the Discord Developer Portal or login fails. Do not add further privileged intents, and do not use these two for anything beyond moderation.
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
| `utils/spam/` | `detector.js`, `state.js` and `patterns.js` must stay free of discord.js — that is what makes them testable with plain object literals. Only `enforcement.js` and `alert.js` touch Discord types. |

## Commands

- One file per command under `commands/`, exporting `data` (a `SlashCommandBuilder`), `execute(interaction)`, plus `help` and `category` strings.
- The loader is recursive and automatic. Never maintain a manual command list.
- Registration scope is driven by `GUILD_ID`: set means guild-scoped plus a wipe of the global set (duplicates otherwise), unset means global. The wipe must stay conditional on the guild registration having succeeded — clearing first would leave the application with no commands if the guild call fails.
- Export `buildEmbed` (and any pure helper) so it can be tested without an interaction.
- Always `deferReply()` first — Blizzard calls routinely exceed Discord's 3-second interaction window.
- Handle `404` inside the command when a specific message helps the user (name the realm slug that was tried). Let every other error propagate; `handlers/interactionHandler.js` translates it.
- Use `addRegionOption` / `resolveRegion` from `utils/commandOptions.js` so every command takes `region` identically.

## Blizzard API gotchas

- Namespaces are mandatory: `profile-{region}` for characters, `dynamic-{region}` for realms and the token, `static-{region}` for items.
- Namespaces also carry the game version: `dynamic-classic-us`, `profile-classicann-us`. Build them with `buildNamespace` from `config/`; never concatenate by hand.
- **A 403 does not mean a namespace is absent.** An invalid namespace and an unauthorised one return an identical generic `403 Forbidden`, so probing for namespace names proves nothing either way. `classicann` (TBC Anniversary) is undocumented in the API reference and was found only on Blizzard's API forum. If a realm seems missing, suspect a namespace you do not know about before concluding the data is unpublished.
- **Never derive a realm slug when you can resolve one.** Use `resolveRealm` from `utils/blizzard/realms.js`, which matches against the live index. Blizzard deletes hyphens and apostrophes (`Azjol-Nerub` → `azjolnerub`) but keeps accents (`festung-der-stürme`), so the naive transformation is wrong for roughly a quarter of realms. `slugifyRealm` implements the verified rule and exists as the offline fallback.
- Character names must be lowercased in paths — use `encodeCharacterName`.
- **Endpoint wrappers take realm SLUGS, never names.** `slugifyRealm` is not idempotent: it deletes hyphens, so applying it to an existing slug turns `area-52` into `area52` and every request 404s. Resolve once with `resolveRealm`, then pass the slug down.
- Equipment payloads omit `level.value` on Classic and Anniversary; only retail supplies item levels. Render it conditionally.
- Search endpoints return **localized maps** (`{ en_US: "..." }`) while direct document fetches return plain strings. Run anything user-visible through `localized()`.
- Realm status and population live on the **connected realm**, not the realm document.
- Mythic+ ratings are RGB component objects, not integers; `ratingColor()` packs them.
- Currency values are in copper. `formatGold()` converts.

## Spam detection

- Detection is **signal counting, not scoring**: each check contributes one human-readable string, and the count is compared against a trust-tier requirement. Resist adding weights.
- Trust tiers come from account age and server tenure only. There is no strike counter and no offender history — that is deliberate, since persisting punishment records would mean a real database.
- Sliding-window state is in memory and self-sweeping. Anything added there must expire, or the maps grow forever.
- **Never act without `enforcement.preflight()`.** It checks bot permissions, the server owner, and role hierarchy. A blocked action still raises an alert; silent failure is the worst outcome.
- New scam patterns need a negative test proving ordinary guild chat does not match. `/spam test` exists for tuning them safely.

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
