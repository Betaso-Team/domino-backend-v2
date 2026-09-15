import { type SchemaType, schema, t } from "@colyseus/schema";

export const GameModeCount = schema(
  {
    // Se conserva el nombre del wire de v1 aunque el valor sea el UUID del modo.
    gameModeName: t.string(),
    playerCount: t.number().default(0),
  },
  "GameModeCount",
);
export type GameModeCount = SchemaType<typeof GameModeCount>;

export const DEFAULT_MAINTENANCE_MESSAGE =
  "El juego de dominó está en mantenimiento. Vuelve pronto.";

export const LobbyRoomState = schema(
  {
    totalPlayers: t.number().default(0),
    playersInLobby: t.number().default(0),
    isUnderMaintenance: t.boolean().default(false),
    maintenanceMessage: t.string().default(DEFAULT_MAINTENANCE_MESSAGE),
    gameModesCount: t.array(GameModeCount),
  },
  "LobbyRoomState",
);
export type LobbyRoomState = SchemaType<typeof LobbyRoomState>;
