export type TownJoinResponse = {
  /** Unique ID that represents this player * */
  userID: string;
  /** Secret token that this player should use to authenticate
   * in future requests to this service * */
  sessionToken: string;
  /** Secret token that this player should use to authenticate
   * in future requests to the video service * */
  providerVideoToken: string;
  /** List of players currently in this town * */
  currentPlayers: Player[];
  /** Friendly name of this town * */
  friendlyName: string;
  /** Is this a private town? * */
  isPubliclyListed: boolean;
  /** Current state of interactables in this town */
  interactables: TypedInteractable[];
  /**
   * Public view of this town's AI Town Guide. Optional so that existing fixtures (and towns
   * created before NPC support) remain valid. Never contains the owner's domainContext.
   */
  npc?: NpcModel;
}

export type InteractableType = 'ConversationArea' | 'ViewingArea' | 'TicTacToeArea' | 'ConnectFourArea';
export interface Interactable {
  type: InteractableType;
  id: InteractableID;
  occupants: PlayerID[];
}

export type TownSettingsUpdate = {
  friendlyName?: string;
  isPubliclyListed?: boolean;
}

export type Direction = 'front' | 'back' | 'left' | 'right';

export type PlayerID = string;
export interface Player {
  id: PlayerID;
  userName: string;
  location: PlayerLocation;
};

export type XY = { x: number, y: number };

/** Unique ID that identifies an NPC (the "AI Town Guide") within a town */
export type NpcID = string;

/**
 * Character model of the AI Town Guide. The API stores these IDs; the frontend maps them to
 * labels and sprites. Listed in the design's picker order (index 0-5):
 * - 'sky-explorer-male': "Sky Explorer · Male"
 * - 'cozy-guide-male': "Cozy Guide · Male"
 * - 'tech-friend-male': "Tech Friend · Male"
 * - 'sky-explorer-female': "Sky Explorer · Female" (default)
 * - 'cozy-guide-female': "Cozy Guide · Female"
 * - 'tech-friend-female': "Tech Friend · Female"
 */
export type NpcAppearanceID =
  | 'sky-explorer-male'
  | 'cozy-guide-male'
  | 'tech-friend-male'
  | 'sky-explorer-female'
  | 'cozy-guide-female'
  | 'tech-friend-female';

/**
 * Personality of the AI Town Guide, chosen from the design's "Personality Type" dropdown:
 * - 'friendly-helper': "Friendly helper" (default)
 * - 'curious-explorer': "Curious explorer"
 * - 'witty-sidekick': "Witty sidekick"
 * - 'calm-mentor': "Calm mentor"
 *
 * Because this is a fixed list, the server maps each ID to its own prompt text, and the owner
 * cannot inject free text into the persona part of the LLM prompt.
 */
export type NpcPersonality = 'friendly-helper' | 'curious-explorer' | 'witty-sidekick' | 'calm-mentor';

/**
 * Owner-provided configuration of a town's AI Town Guide, set on the town-creation form.
 * Length limits are enforced by tsoa request validation (422 on violation).
 *
 * Defaults (used when the "Add an AI Town Guide" toggle is off, or for any omitted field):
 * name "Jane Doe", appearance 'sky-explorer-female', personality 'friendly-helper',
 * no domainContext.
 */
export interface NpcConfig {
  /**
   * Name shown for the guide ("AI Town Guide Name")
   * @minLength 1
   * @maxLength 24
   */
  name: string;
  /** Character model ("Character Model") */
  appearance: NpcAppearanceID;
  /** Personality ("Personality Type") */
  personality: NpcPersonality;
  /**
   * Optional background knowledge for the guide. Not on the design's form, but required by
   * User Story 1. Owner-only: it is never broadcast to clients.
   * @minLength 1
   * @maxLength 500
   */
  domainContext?: string;
}

/**
 * NPC configuration as accepted in requests: every field is optional, and omitted fields
 * fall back to the defaults documented on NpcConfig.
 */
export type NpcConfigInput = Partial<NpcConfig>;

/** What the NPC is currently doing: walking its route, or stopped and facing a player */
export type NpcActivityState = 'patrolling' | 'facing-player';

/**
 * Public view of the AI Town Guide that is sent to every client in the town (players see the
 * guide's name and model, and the chat header shows "● Online · <personality>").
 * Intentionally excludes domainContext.
 */
export interface NpcModel {
  id: NpcID;
  name: string;
  appearance: NpcAppearanceID;
  personality: NpcPersonality;
  location: PlayerLocation;
  state: NpcActivityState;
}

/**
 * Kind of live activity the AI Town Guide can recommend:
 * - 'conversation': a ConversationArea with a topic
 * - 'video': a ViewingArea with a video
 * - 'game': a TicTacToe or ConnectFour GameArea
 */
export type ActivityKind = 'conversation' | 'video' | 'game';

/** Which game a 'game' activity is running */
export type GameKind = 'TicTacToe' | 'ConnectFour';

/** Where an activity is, so the guide can point the player to it */
export interface ActivityLocation {
  /**
   * Human-readable zone of the town (e.g. "Foyer", "Basement"). The tilemap has no room
   * concept, so this will come from a future area-to-room config (Task 2.5).
   */
  zone: string;
  /** Center of the area's bounding box, in map pixels */
  center: XY;
}

/**
 * One live activity, as shown in the "Find an Activity" list ("<areaName> · <playerNames>")
 * and as given to the LLM. Contains player userNames (already visible to everyone in the
 * town) but never player IDs or session tokens.
 */
export interface ActivitySummary {
  interactableID: InteractableID;
  kind: ActivityKind;
  /** Display name of the area from the tilemap (e.g. "Connect Four 2"); same as the ID today */
  areaName: string;
  /** The conversation topic or the video URL; omitted for games */
  description?: string;
  /** Number of players currently in the area (for games this includes spectators) */
  occupantCount: number;
  /**
   * userNames of the people doing the activity: the game's players for a game, otherwise the
   * area's occupants
   */
  playerNames: string[];
  /** Set only when kind is 'game' */
  gameKind?: GameKind;
  /** Set only when kind is 'game'; never 'OVER', because finished games are not active */
  gameStatus?: GameStatus;
  /** Set only when kind is 'game': true if another player can still join */
  hasOpenSeat?: boolean;
  location: ActivityLocation;
}

/**
 * Snapshot of every active area in a town, built by the server from Town.interactables.
 * Only active areas are included, sorted by occupantCount descending: index 0 is the
 * "most popular" fallback, and an empty list means the town is quiet.
 */
export interface TownActivitySnapshot {
  townID: string;
  /** When the snapshot was built, as an ISO 8601 string */
  generatedAt: string;
  /** Number of players currently in the town */
  totalPlayers: number;
  activities: ActivitySummary[];
}

/**
 * Body of a recommendation request to the AI Town Guide. If neither field is set, the guide
 * recommends the best overall activity.
 *
 * Planned routes (implemented in Task 3.3, not yet added):
 * - GET  /towns/{townID}/npcs/{npcID}/activities -> ActivitySummary[]
 * - POST /towns/{townID}/npcs/{npcID}/recommendation, body RecommendationRequest
 *   -> RecommendationResponse
 */
export interface RecommendationRequest {
  /** The activity the player picked from the "Find an Activity" list */
  interactableID?: InteractableID;
  /**
   * Free-text question or interests typed by the player
   * @maxLength 300
   */
  interests?: string;
}

/**
 * Outcome of a recommendation request:
 * - 'ok': a recommendation was made
 * - 'follow_up': the guide needs more information and asks a follow-up question
 * - 'town_quiet': there are no active areas
 * - 'no_longer_active': the picked activity ended before the guide answered
 * - 'turn_limit': the player reached the 5-turn cap for this conversation
 * - 'llm_unavailable': the LLM failed or took longer than 5 s
 */
export type RecommendationStatus =
  | 'ok'
  | 'follow_up'
  | 'town_quiet'
  | 'no_longer_active'
  | 'turn_limit'
  | 'llm_unavailable';

/** The AI Town Guide's reply to a recommendation request */
export interface RecommendationResponse {
  status: RecommendationStatus;
  /** Text of one chat bubble */
  text: string;
  /** The recommended activity, when there is one */
  activity?: ActivitySummary;
}

export interface PlayerLocation {
  /* The CENTER x coordinate of this player's location */
  x: number;
  /* The CENTER y coordinate of this player's location */
  y: number;
  /** @enum {string} */
  rotation: Direction;
  moving: boolean;
  interactableID?: string;
};
export type ChatMessage = {
  author: string;
  sid: string;
  body: string;
  dateCreated: Date;
  interactableID?: string;
};

export interface ConversationArea extends Interactable {
  topic?: string;
};
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
};

export interface ViewingArea extends Interactable {
  video?: string;
  isPlaying: boolean;
  elapsedTimeSec: number;
}

export type GameStatus = 'IN_PROGRESS' | 'WAITING_TO_START' | 'OVER' | 'WAITING_FOR_PLAYERS';
/**
 * Base type for the state of a game
 */
export interface GameState {
  status: GameStatus;
} 

/**
 * Type for the state of a game that can be won
 */
export interface WinnableGameState extends GameState {
  winner?: PlayerID;
}
/**
 * Base type for a move in a game. Implementers should also extend MoveType
 * @see MoveType
 */
export interface GameMove<MoveType> {
  playerID: PlayerID;
  gameID: GameInstanceID;
  move: MoveType;
}

export type TicTacToeGridPosition = 0 | 1 | 2;

/**
 * Type for a move in TicTacToe
 */
export interface TicTacToeMove {
  gamePiece: 'X' | 'O';
  row: TicTacToeGridPosition;
  col: TicTacToeGridPosition;
}

/**
 * Type for the state of a TicTacToe game
 * The state of the game is represented as a list of moves, and the playerIDs of the players (x and o)
 * The first player to join the game is x, the second is o
 */
export interface TicTacToeGameState extends WinnableGameState {
  moves: ReadonlyArray<TicTacToeMove>;
  x?: PlayerID;
  o?: PlayerID;
}

/**
 * Type for the state of a ConnectFour game.
 * The state of the game is represented as a list of moves, and the playerIDs of the players (red and yellow)
 */
export interface ConnectFourGameState extends WinnableGameState {
  // The moves in this game
  moves: ReadonlyArray<ConnectFourMove>;
  // The playerID of the red player, if any
  red?: PlayerID;
  // The playerID of the yellow player, if any
  yellow?: PlayerID;
  // Whether the red player is ready to start the game
  redReady?: boolean;
  // Whether the yellow player is ready to start the game
  yellowReady?: boolean;
  // The color of the player who will make the first move
  firstPlayer: ConnectFourColor;
}

/**
 * Type for a move in ConnectFour
 * Columns are numbered 0-6, with 0 being the leftmost column
 * Rows are numbered 0-5, with 0 being the top row
 */
export interface ConnectFourMove {
  gamePiece: ConnectFourColor;
  col: ConnectFourColIndex;
  row: ConnectFourRowIndex;
}

/**
 * Row indices in ConnectFour start at the top of the board and go down
 */
export type ConnectFourRowIndex = 0 | 1 | 2 | 3 | 4 | 5;
/**
 * Column indices in ConnectFour start at the left of the board and go right
 */
export type ConnectFourColIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type ConnectFourColor = 'Red' | 'Yellow';

export type InteractableID = string;
export type GameInstanceID = string;

/**
 * Type for the result of a game
 */
export interface GameResult {
  gameID: GameInstanceID;
  scores: { [playerName: string]: number };
}

/**
 * Base type for an *instance* of a game. An instance of a game
 * consists of the present state of the game (which can change over time),
 * the players in the game, and the result of the game
 * @see GameState
 */
export interface GameInstance<T extends GameState> {
  state: T;
  id: GameInstanceID;
  players: PlayerID[];
  result?: GameResult;
}

/**
 * Base type for an area that can host a game
 * @see GameInstance
 */
export interface GameArea<T extends GameState> extends Interactable {
  game: GameInstance<T> | undefined;
  history: GameResult[];
}

export type CommandID = string;

/**
 * Base type for a command that can be sent to an interactable.
 * This type is used only by the client/server interface, which decorates
 * an @see InteractableCommand with a commandID and interactableID
 */
interface InteractableCommandBase {
  /**
   * A unique ID for this command. This ID is used to match a command against a response
   */
  commandID: CommandID;
  /**
   * The ID of the interactable that this command is being sent to
   */
  interactableID: InteractableID;
  /**
   * The type of this command
   */
  type: string;
}

export type InteractableCommand =  ViewingAreaUpdateCommand | JoinGameCommand | GameMoveCommand<TicTacToeMove> | GameMoveCommand<ConnectFourMove> | StartGameCommand | LeaveGameCommand;
export interface ViewingAreaUpdateCommand  {
  type: 'ViewingAreaUpdate';
  update: ViewingArea;
}
export interface JoinGameCommand {
  type: 'JoinGame';
}
export interface LeaveGameCommand {
  type: 'LeaveGame';
  gameID: GameInstanceID;
}
export interface StartGameCommand {
  type: 'StartGame';
  gameID: GameInstanceID;
}
export interface GameMoveCommand<MoveType> {
  type: 'GameMove';
  gameID: GameInstanceID;
  move: MoveType;
}
export type InteractableCommandReturnType<CommandType extends InteractableCommand> = 
  CommandType extends JoinGameCommand ? { gameID: string}:
  CommandType extends ViewingAreaUpdateCommand ? undefined :
  CommandType extends GameMoveCommand<TicTacToeMove> ? undefined :
  CommandType extends LeaveGameCommand ? undefined :
  never;

export type InteractableCommandResponse<MessageType> = {
  commandID: CommandID;
  interactableID: InteractableID;
  error?: string;
  payload?: InteractableCommandResponseMap[MessageType];
}

export interface ServerToClientEvents {
  playerMoved: (movedPlayer: Player) => void;
  playerDisconnect: (disconnectedPlayer: Player) => void;
  playerJoined: (newPlayer: Player) => void;
  initialize: (initialData: TownJoinResponse) => void;
  townSettingsUpdated: (update: TownSettingsUpdate) => void;
  townClosing: () => void;
  chatMessage: (message: ChatMessage) => void;
  interactableUpdate: (interactable: Interactable) => void;
  commandResponse: (response: InteractableCommandResponse) => void;
  /** Sent whenever the town's NPC moves or changes state */
  npcUpdated: (npc: NpcModel) => void;
}

export interface ClientToServerEvents {
  chatMessage: (message: ChatMessage) => void;
  playerMovement: (movementData: PlayerLocation) => void;
  interactableUpdate: (update: Interactable) => void;
  interactableCommand: (command: InteractableCommand & InteractableCommandBase) => void;
}