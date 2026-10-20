# NPC Backend Design

Backend design notes for the AI Town Guide (NPC) feature. The UI source of truth is the team's
Figma Make design "Wizard of Oz Demo (Empty Town)" v26.

## Task 1.4: Town persistence, auth and shared NPC schemas

User Story 1: the town owner sets up an "AI Town Guide" when creating a town.

### How towns are stored

- Towns are **not persisted**. `TownsStore` (`townService/src/lib/TownsStore.ts`) is an
  in-memory singleton that holds a `Town[]`. It is created once by
  `TownsStore.initializeTownsStore(emitterFactory)` in `Server.ts`; after that, every caller
  uses `TownsStore.getInstance()`.
- `createTown` builds a `Town`, loads the Tiled map, and pushes the town into the array.
  `getTownByID` does a linear search over that array.
- `deleteTown` filters the town out of the array and calls `disconnectAllPlayers()`. Nothing
  else holds a reference to the town, so it gets garbage collected.
- **Consequence for NPCs:** if the NPC config lives on the `Town` object (or on an object that
  only the `Town` references), deleting the town removes it too. There is no separate cleanup
  step, and restarting the server clears every town and every NPC config.

### Password lifecycle

1. The `Town` constructor generates `townUpdatePassword = nanoid(24)`. The town cannot exist
   without one.
2. `POST /towns` returns `{ townID, townUpdatePassword }`, and only the creator receives this
   password. The frontend keeps it so that the owner can edit or delete the town later.
3. `PATCH /towns/{townID}` (update) and `DELETE /towns/{townID}` read the
   `X-CoveyTown-Password` header and check it with `passwordMatches(provided, expected)`.
4. `passwordMatches` also accepts `process.env.MASTER_TOWN_PASSWORD` when that variable is
   set. **Bug fixed in this task:** the comparison read `MASTER_TOWN_PASWORD` (typo), so the
   master password never matched. New tests in `TownsController.test.ts` under
   `updateTown > MASTER_TOWN_PASSWORD` cover:
   - the master password is accepted;
   - a wrong password is still rejected when a master password is set;
   - an empty password is rejected when no master password is set.

### Authorization decision

- **Creating:** the NPC config goes in the `POST /towns` body (`TownCreateParams.npcConfig`)
  **with no password**. The update password is only generated inside the `Town`
  constructor, so the person creating the town is its owner by definition.
- **Editing (future, not part of this task):** `PATCH /towns/{townID}/npc`, protected by
  `X-CoveyTown-Password` and the same `passwordMatches` check.
- **Not in `TownSettingsUpdate`:** the `Town` setters for `friendlyName` and
  `isPubliclyListed` broadcast each change to every client through `townSettingsUpdated`, so
  anything added there would reach every player.
- **IDs, not labels:** the API stores IDs such as `'sky-explorer-female'`. The frontend maps
  IDs to display labels and sprites.
- Clients only ever receive `NpcModel` (in `TownJoinResponse.npc` and `npcUpdated`), which
  leaves out `domainContext`.

### Figma design element to backend field

| Design element (town-creation form) | Backend field | Notes |
| --- | --- | --- |
| "Add an AI Town Guide" toggle (on by default) | presence of `npcConfig` | OFF means "use the default guide", not "no guide". The frontend can omit `npcConfig`, and the server creates the default guide |
| "AI Town Guide Name" text box | `NpcConfig.name` | 1–24 characters |
| Character Model picker (6 models) | `NpcConfig.appearance: NpcAppearanceID` | Picker order: `sky-explorer-male`, `cozy-guide-male`, `tech-friend-male`, `sky-explorer-female`, `cozy-guide-female`, `tech-friend-female` |
| "Personality Type" dropdown | `NpcConfig.personality: NpcPersonality` | `friendly-helper` "Friendly helper", `curious-explorer` "Curious explorer", `witty-sidekick` "Witty sidekick", `calm-mentor` "Calm mentor" |
| *(not on the form)* | `NpcConfig.domainContext?` | Optional, 1–500 characters, owner-only and never broadcast. Required by Story 1 |
| Guide name and model seen by joining players | `TownJoinResponse.npc: NpcModel` (`name`, `appearance`) | |
| Chat header "● Online · &lt;personality&gt;" | `NpcModel.personality` | The frontend maps the ID to its label |
| NPC walking / stopping for a player | `NpcModel.state: NpcActivityState` | `'patrolling'` or `'facing-player'`, pushed with the `npcUpdated` event |

### Defaults

These apply when the toggle is off, `npcConfig` is omitted, or any field is left out:

| Field | Default |
| --- | --- |
| `name` | `"Jane Doe"` |
| `appearance` | `'sky-explorer-female'` (picker index 3) |
| `personality` | `'friendly-helper'` |
| `domainContext` | none |

`shared/` contains types only, so the runtime default object belongs in `townService` (and
in `frontend` for the form's initial values).

### New shared types (`shared/types/CoveyTownSocket.d.ts`)

| Type | Definition |
| --- | --- |
| `NpcID` | `string` |
| `NpcAppearanceID` | the six character-model IDs above |
| `NpcPersonality` | the four personality IDs above. Because the list is fixed, the owner can't inject free text into the persona part of the prompt |
| `NpcConfig` | `{ name; appearance; personality; domainContext? }`, with tsoa `@minLength`/`@maxLength` on the strings |
| `NpcConfigInput` | `Partial<NpcConfig>`. tsoa emits it as `Partial_NpcConfig_` and keeps the enums and limits |
| `NpcActivityState` | `'patrolling' \| 'facing-player'` |
| `NpcModel` | `{ id; name; appearance; personality; location: PlayerLocation; state }`. This is the public view, without `domainContext` |
| `TownJoinResponse.npc?` | `NpcModel`. Optional so that existing fixtures compile |
| `ServerToClientEvents.npcUpdated` | `(npc: NpcModel) => void` |

`townService/src/api/Model.ts` adds `npcConfig?: NpcConfigInput` to `TownCreateParams`. The
generated routes validate it, so a bad enum value or a string that breaks a length limit
makes tsoa throw `ValidateError`, and `Server.ts` turns that into a **422**.
`TownsController.createTown` does not store `npcConfig` yet; that is a later task.

### Gotcha: `InvalidParametersError` returns 500, not 400

`TownsController` documents `@Response<InvalidParametersError>(400, ...)`, but
`InvalidParametersError` is a plain `Error` subclass. The error middleware in `Server.ts`
handles only two cases: `ValidateError`, which returns 422, and any other `Error`, which
returns **500** "Internal Server Error". As a result, a wrong password or a bad update value
returns 500 even though the swagger spec says 400. This is not fixed here; it belongs to
**Task 2.4**.
