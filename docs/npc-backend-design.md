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

## Task 1.5: Activity and occupant tracking, recommendation schemas

User Story 2: the guide recommends live activities that have players in them. This task only
adds types and docs. The routes and server logic come in Task 3.3.

### Trace

- **Every activity is an `InteractableArea`** in `Town._interactables`.
  `Town.initializeFromMap` builds them from the tilemap's `Objects` layer:
  `ViewingArea.fromMapObject`, `ConversationArea.fromMapObject`, and `GameAreaFactory` (which
  reads the `type` property, `TicTacToe` or `ConnectFour`). The area's ID is the map
  object's name, so the display name and the ID are the same today.
- **Occupants are kept current by `Town._updatePlayerLocation`** on every `playerMovement`.
  It removes the player from the area they left and adds them to the area they entered.
  The server holds everything a snapshot needs (areas, occupants, game state, players'
  `userName`s), so **no data is needed from the frontend**.
- **Correction 1 to the earlier read:** `_updatePlayerLocation` only adds a player to an
  area that is already `isActive`. Conversation and viewing areas count as active only when
  they have occupants, so walking into an empty one does not make you an occupant. You become
  one when someone sets the topic or video (`Town.addConversationArea` /
  `addViewingArea` call `addPlayersWithinBounds`). For recommendations, this means
  conversation and viewing occupants are the players who are actually taking part.
- **Correction 2 to the earlier read:** `GameArea.isActive` is always `true`, and the game
  object stays around after its players leave. If the last player leaves before a game
  starts, Connect Four stays at `WAITING_FOR_PLAYERS` and Tic Tac Toe resets to
  `WAITING_TO_START`, in both cases with **no players**. So status alone is not enough; the
  game must also have at least one player.
- `ConversationArea.remove()` clears the topic, and `ViewingArea.remove()` clears the video,
  when the last occupant leaves.
- The map's `video` property on viewing areas is ignored by `ViewingArea.fromMapObject`, so
  every viewing area starts with no video.

### Inclusion rules ("active")

| Area type | Active when | `playerNames` from |
| --- | --- | --- |
| `ConversationArea` | `topic` is set and occupants > 0 | area occupants |
| `ViewingArea` | `video` is set and occupants > 0 | area occupants |
| `GameArea` | `game` exists, `game.state.status` is `WAITING_FOR_PLAYERS`, `WAITING_TO_START` or `IN_PROGRESS` (not `OVER`), **and** `game.players.length > 0` | the game's players (the area's occupants also include spectators) |

For games, `hasOpenSeat` is true while the game has fewer than 2 players.

### Tilemap (`frontend/public/assets/tilemaps/indoors.json`)

There are no rooms. The `Objects` layer contains:

| Name | Type |
| --- | --- |
| Foyer Table 1–7 | ConversationArea |
| Basement Dining Table 1 | ConversationArea |
| Tic Tac Toe 1 | GameArea (`TicTacToe`) |
| **Tic Tac Toe 2** | **ConversationArea** (it has a `type: TicTacToe` property, but its object type is wrong) |
| Connect Four 1, Connect Four 2 | GameArea (`ConnectFour`) |
| Fish tank, Basement TV | ViewingArea |

The map also has two transporters ("Stairs to basement" / "Stairs Up"), a spawn point and
two unnamed objects. The only hint of rooms is in the area names ("Foyer…", "Basement…"), so
`ActivityLocation.zone` needs an explicit area-to-room config (Task 2.5).

**Map bug: "Tic Tac Toe 2"** is created as a conversation area, so it can never host a game.
Once someone sets a topic there, it shows up in recommendations as a conversation called
"Tic Tac Toe 2". This task leaves the map unchanged; the team should decide whether to fix
it (change the type to `GameArea`) or exclude it.

### Design flow (Figma "Wizard of Oz Demo (Empty Town)" v26)

1. The guide greets the player and offers two buttons: **"Find an Activity"** and **"Catch Up
   on a Conversation"** (the second is Task 1.7).
2. "Find an Activity" lists live activities as `"<areaName> · <playerNames>"`, e.g.
   "Connect Four 2 · Alex & Sam", "Tic Tac Toe 1 · Priya & Jordan", "Basement Dining Table 1
   · Taylor & Morgan". The sidebar shows "3 ongoing activities"
   (`TownActivitySnapshot.activities.length`).
3. Picking one sends `RecommendationRequest.interactableID`, and the reply names the players,
   e.g. "Alex and Sam are playing Connect Four. This is a good choice if you want a quick
   strategy game...".
4. The player can also type a free-text question (`RecommendationRequest.interests`).
5. In an empty town, the guide says: "There are no ongoing activities yet. Please check back
   when more players join the town." (`status: 'town_quiet'`).

**Team decision:** player `userName`s appear in both the UI list and the LLM prompt, because
everyone in the town can already see them. Player IDs and session tokens are never included.
`interests` is player-written text that will go into the prompt, so Task 3.3 should treat it
as untrusted (keep it to 300 characters and clearly separate it from the instructions).

### Schema (`shared/types/CoveyTownSocket.d.ts`)

| Type | Definition |
| --- | --- |
| `ActivityKind` | `'conversation' \| 'video' \| 'game'` |
| `GameKind` | `'TicTacToe' \| 'ConnectFour'` |
| `ActivityLocation` | `{ zone; center: XY }` |
| `ActivitySummary` | `{ interactableID; kind; areaName; description?; occupantCount; playerNames; gameKind?; gameStatus?; hasOpenSeat?; location }` |
| `TownActivitySnapshot` | `{ townID; generatedAt (ISO string); totalPlayers; activities }`. Contains active areas only, sorted by `occupantCount` descending |
| `RecommendationRequest` | `{ interactableID?; interests? (max 300 characters) }`. If neither is set, the guide picks the best overall activity |
| `RecommendationStatus` | `'ok' \| 'follow_up' \| 'town_quiet' \| 'no_longer_active' \| 'turn_limit' \| 'llm_unavailable'` |
| `RecommendationResponse` | `{ status; text (one chat bubble); activity? }` |

Planned routes (Task 3.3; not added yet):

```
GET  /towns/{townID}/npcs/{npcID}/activities      -> ActivitySummary[]
POST /towns/{townID}/npcs/{npcID}/recommendation  body RecommendationRequest
                                                  -> RecommendationResponse
```

### Status to Story 2 conditions of satisfaction

| `RecommendationStatus` | Story 2 condition of satisfaction | Design |
| --- | --- | --- |
| `ok` | The guide recommends a live activity that has players in it, naming them | "Alex and Sam are playing Connect Four. This is a good choice if…" |
| `ok` (no pick, no clear interest) | **Most-popular fallback:** recommend `activities[0]` | Same bubble, for the most popular activity |
| `follow_up` | **Follow-up question** when the player's request is too vague to match | Guide bubble asking a question; the player can type a reply |
| `town_quiet` | **Town quiet:** no active areas | "There are no ongoing activities yet. Please check back when more players join the town." |
| `no_longer_active` | The picked activity ended between listing and picking (the snapshot is out of date) | Bubble saying it has ended, and the list is refreshed |
| `turn_limit` | **5-turn cap** per conversation with the guide | Final bubble; the player can start over |
| `llm_unavailable` | **LLM timeout (> 5 s)** or error: fail gracefully | Apology bubble (the design has no copy for this yet) |

## Task 1.7: Conversation-area catch-up endpoints, types and socket events

User Story 3: a player who arrives late asks the guide to summarise a conversation area's
text chat. This task only adds types and docs; no routes or server logic.

### Trace

All of the earlier findings were confirmed:

- **Area chat already works.** `frontend/src/classes/TextConversation.ts` tags each message
  with `interactableID` and keeps only matching messages. `Town.ts` handles the
  `chatMessage` socket event: it broadcasts the message to the **whole town**, then pushes it
  into a single town-wide `_chatMessages` array capped at **200** (`shift()` drops the
  oldest). `GET /towns/{townID}/chatMessages?interactableID=` (requires `X-Session-Token`)
  returns `Town.getChatMessages(interactableID)`, which filters that array.
- **`ChatMessage.author` is set by the client** (`TextConversation` uses its own
  `userName`), and the server stores it unchanged, so it can be spoofed. The same goes for
  `dateCreated` and `sid`. The server needs to stamp the author **and the time** itself
  (Task 2.6); otherwise attribution and the summary window can't be trusted.
- **The 200 cap applies to the whole town**, so in a busy town a quiet area's history gets
  pushed out by other areas. Task 2.5 needs a separate buffer per area.
- **Nothing records when a topic was set.** `Town.addConversationArea` only assigns
  `area.topic`. `topicSetAt` (and each player's entry time into the area) need to be tracked
  on the server.
- **`ConversationArea.remove()` clears the topic when the last occupant leaves.** This is
  where a session ends. Today the area's old messages stay in `_chatMessages` and get mixed
  into the next session under the same `interactableID`, which is why
  `conversationAreaChatCleared` is added.
- **`InteractableArea.handleCommand` is synchronous.** `Town`'s `interactableCommand`
  handler calls it and immediately emits `commandResponse`. An LLM summary is async, so it
  should be a REST route, not an `interactableCommand`.
- **FYI (frontend bug):** `TextConversation.close()` calls
  `removeAllListeners('chatMessage')` on the shared `TownController`. When `ChatProvider`
  closes one conversation, every other conversation's listeners are removed as well.
  `offMessageAdded`-style cleanup that removes only its own listener would fix it.
- **Additional findings:** the server doesn't check that the sender of a `chatMessage` is
  actually in the `interactableID` they tagged, and `GET chatMessages` doesn't check that the
  reader is in that area. Any player can post to or read any area's chat.

### Design alignment (Figma "Wizard of Oz Demo (Empty Town)" v26)

| Design | Backend |
| --- | --- |
| "Catch Up on a Conversation" list: `"<topic> · <playerNames>"`, e.g. "Software Engineering Project · Taylor & Morgan" | `ActiveConversationAreaInfo.topic`, `.playerNames` |
| One paragraph naming who said what: "Catch-up — Software Engineering Project: Taylor and Morgan discussed their project. They agreed to keep the demo simple…" | `CatchUpResponse.topic` + `.summary` |
| *(not shown in the UI)* | `CatchUpResponse.bullets`: up to 5 `CatchUpBullet`s with `raisedBy`, so attribution can be tested (Story 3) |
| "There are no current conversations yet. Please check back when players join the town." | an empty `ActiveConversationAreaInfo[]` |

**Team decision:** the response includes **both** the `summary` paragraph (for the UI)
**and** up to 5 structured bullets with `raisedBy`. Every name in `summary` must appear in
some bullet's `raisedBy`, and `raisedBy` may contain only server-stamped authors from the
window. Task 3.x should reject or retry any LLM output that breaks this rule.

### Schema (`shared/types/CoveyTownSocket.d.ts`)

| Type | Definition |
| --- | --- |
| `ActiveConversationAreaInfo` | `{ interactableID; areaName; topic; occupantCount; playerNames; topicSetAt (epoch ms); messageCount }` |
| `CatchUpRequest` | `{ interactableID }` |
| `CatchUpBullet` | `{ kind: 'point' \| 'decision' \| 'question'; text (max 300 characters); raisedBy: string[] }` |
| `CatchUpStatus` | `'ok' \| 'nothing_missed' \| 'no_active_area' \| 'rate_limited' \| 'llm_unavailable'` |
| `CatchUpResponse` | `{ status; interactableID; topic?; summary?; bullets (max 5); windowStart?; windowEnd?; retryAfterSec? }` |
| `ServerToClientEvents.conversationAreaChatCleared` | `(interactableID: InteractableID) => void` |

`topicSetAt` is deliberately **not** added to the `ConversationArea` model, because clients
POST that type to create conversation areas. A client-supplied `topicSetAt` couldn't be
trusted, and adding the field would change the request schema.

### Planned routes (not added yet)

```
GET  /towns/{townID}/npcs/{npcID}/conversationAreas -> ActiveConversationAreaInfo[]
POST /towns/{townID}/npcs/{npcID}/catchUp  body CatchUpRequest -> CatchUpResponse
```

Both routes require:
- a valid `X-Session-Token` (the player must be in the town);
- the player to be **within 3 tiles of the NPC**;
- the area to be **in the NPC's room** (using the area-to-room config from Task 2.5).

### Status to Story 3 conditions of satisfaction

| `CatchUpStatus` | Story 3 condition of satisfaction | Design copy |
| --- | --- | --- |
| `ok` | A late player gets a summary of the area's text chat that says who said what | "Catch-up — &lt;topic&gt;: Taylor and Morgan discussed…" |
| `nothing_missed` | No messages in the window, so there is nothing to summarise | No copy yet (e.g. "Nothing has been said yet in &lt;topic&gt;.") |
| `no_active_area` | Only active conversation areas (topic set and occupants > 0) can be summarised | "There are no current conversations yet. Please check back when players join the town." (when the list is empty) |
| `rate_limited` | At most 1 catch-up every 30 s per player | No copy yet ("Please wait &lt;retryAfterSec&gt; s") |
| `llm_unavailable` | The LLM failed or took longer than 5 s: fail gracefully | No copy yet (apology bubble) |

### Summary window

The window starts at the area's `topicSetAt` and ends at the **earlier of the player's entry
time into the area or now**. This covers what the player missed before arriving. If the
player never entered the area, it covers everything up to now. Only server-stamped messages
tagged with that area's `interactableID` are included. `windowStart`/`windowEnd` are returned
so the UI and tests can check the range.

### Rate limit

Each player can make **1 catch-up request every 30 s**. A request inside that window gets
`status: 'rate_limited'` with `retryAfterSec` set, and the LLM isn't called.

### Why REST and not sockets

- `handleCommand` is synchronous and can't wait for an LLM call.
- A request/response pair gives a clear per-request status, timeout handling and a
  rate-limit reply, and tsoa validates the body and generates the frontend client
  automatically.
- The summary is meant for one player. Socket chat in this codebase is broadcast to the
  whole town.
- Sockets are still used for the push-only event `conversationAreaChatCleared`.

### Open questions

1. **Scope:** does catch-up cover every conversation area in the town, or only those in the
   guide's room? The plan has a single NPC, so restricting it to the guide's room would hide
   most of the town.
2. **"Tic Tac Toe 2" map bug:** should the map object be fixed (changed to `GameArea`) or
   excluded? As a `ConversationArea` it can show up in the catch-up list. See Task 1.5.
