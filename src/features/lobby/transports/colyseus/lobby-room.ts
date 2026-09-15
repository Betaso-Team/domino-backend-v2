import { type AuthContext, type Client, LobbyRoom as ColyseusLobbyRoom } from "colyseus";
import { rootContainer } from "../../../../di-container.js";
import type { TokenVerifier } from "../../../auth/index.js";
import { GameModeCount, LobbyRoomState } from "../../core/state.js";

interface DominoRoomMetadata {
  readonly gameModeId?: string;
}

type LobbyJoinOptions = Parameters<ColyseusLobbyRoom["onJoin"]>[1];

// El lobby de Colyseus mantiene el listing compartido; este subtipo solo proyecta el árbol
// mínimo que ya consume el front. No hace matchmaking: contar y anunciar mantenimiento no
// necesitan volver a meter esa responsabilidad dentro del socket.
export class LobbyRoom extends ColyseusLobbyRoom<DominoRoomMetadata> {
  declare state: LobbyRoomState;

  static override async onAuth(
    _token: string,
    _options: unknown,
    _context: AuthContext,
  ): Promise<true> {
    return true;
  }

  override async onCreate(options: unknown): Promise<void> {
    this.autoDispose = false;
    this.state = new LobbyRoomState();
    await super.onCreate(options);
    this.refreshCounts();
    // `rooms` se actualiza por el pub/sub nativo de Colyseus. Reproyectarlo no consulta Redis:
    // es un recorrido corto en memoria y mantiene los contadores vivos aunque nadie entre o salga
    // del lobby durante una partida.
    this.clock.setInterval(() => this.refreshCounts(), 1_000);
  }

  override async onAuth(
    _client: Client,
    _options: unknown,
    context: AuthContext,
  ): Promise<Awaited<ReturnType<TokenVerifier["verify"]>>> {
    return rootContainer.resolve<TokenVerifier>("TokenVerifier").verify(context.token ?? undefined);
  }

  override onJoin(client: Client, options: LobbyJoinOptions): void {
    super.onJoin(client, options);
    this.state.playersInLobby = this.clients.length;
    this.refreshCounts();
  }

  override onLeave(client: Client): void {
    super.onLeave(client);
    this.state.playersInLobby = this.clients.length;
    this.refreshCounts();
  }

  private refreshCounts(): void {
    let totalPlayers = 0;
    const byMode = new Map<string, number>();

    for (const room of this.rooms) {
      if (room.name !== "domino" || room.clients <= 0) continue;
      totalPlayers += room.clients;
      const gameModeId = room.metadata?.gameModeId;
      if (gameModeId) byMode.set(gameModeId, (byMode.get(gameModeId) ?? 0) + room.clients);
    }

    this.state.totalPlayers = totalPlayers;
    this.state.gameModesCount.clear();
    for (const [gameModeName, playerCount] of [...byMode].sort(([a], [b]) => a.localeCompare(b))) {
      const count = new GameModeCount();
      count.gameModeName = gameModeName;
      count.playerCount = playerCount;
      this.state.gameModesCount.push(count);
    }
  }
}
